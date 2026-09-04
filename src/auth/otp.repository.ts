import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import type { OtpDeliverySnapshot, OtpDeliveryStart, OtpDeliveryState, SmsDeliveryEvent, SmsFailureReason } from './otp-delivery.models';

type BeginOtpDeliveryInput = {
  id: string; phoneHash: string; otpHash: string; idempotencyKey: string;
  ttlMillis: number; settlementMillis: number;
};
type DeliveryRow = {
  id: string; phone_number_hash: string; delivery_status: OtpDeliveryState;
  provider_message_id: string | null; provider_transaction_id: string | null;
  attempt_number: string; used: boolean;
};

@Injectable()
export class OtpRepository {
  constructor(private readonly database: DatabaseService) {}

  async beginOtpDelivery(input: BeginOtpDeliveryInput): Promise<OtpDeliveryStart> {
    return this.database.transaction(async client => {
      await lockPhone(client, input.phoneHash);
      const inserted = await client.query<{ id: string }>(`
        INSERT INTO otp_verification(id, phone_number_hash, otp_hash, idempotency_key, expires_at, settlement_deadline)
        VALUES ($1, $2, $3, $4, clock_timestamp() + $5 * INTERVAL '1 millisecond',
          clock_timestamp() + $6 * INTERVAL '1 millisecond')
        ON CONFLICT (idempotency_key) DO NOTHING RETURNING id
      `, [input.id, input.phoneHash, input.otpHash, input.idempotencyKey, input.ttlMillis, input.settlementMillis]);
      if (inserted.rows[0]) return { state: 'created', id: inserted.rows[0].id };
      await client.query(`
        UPDATE otp_verification SET delivery_status = 'unknown', delivery_error_code = 'delivery_unknown'
        WHERE idempotency_key = $1 AND phone_number_hash = $2 AND delivery_status = 'pending'
          AND settlement_deadline <= clock_timestamp()
      `, [input.idempotencyKey, input.phoneHash]);
      const existing = (await client.query<DeliveryRow>(`
        SELECT id, phone_number_hash, delivery_status FROM otp_verification WHERE idempotency_key = $1
      `, [input.idempotencyKey])).rows[0];
      if (!existing) throw new Error('OTP idempotency record disappeared');
      if (existing.phone_number_hash !== input.phoneHash) return { state: 'conflict' };
      return { state: existing.delivery_status, id: existing.id };
    });
  }

  async markOtpAccepted(id: string, phoneHash: string, transactionId: string, messageId: string): Promise<boolean> {
    return this.database.transaction(async client => {
      const row = await lockedDelivery(client, id, phoneHash);
      if (!row || !matchesReceipt(row, messageId, transactionId)) return false;
      // A callback can arrive before /send returns. Never downgrade a terminal failure or sms_sent.
      if (row.delivery_status === 'failed') return false;
      await activate(client, row);
      const result = await client.query(`
        UPDATE otp_verification SET
          delivery_status = CASE WHEN delivery_status = 'sent' THEN 'sent' ELSE 'accepted' END,
          provider_transaction_id = $2, provider_message_id = $3,
          sent_at = COALESCE(sent_at, clock_timestamp()), delivery_error_code = NULL
        WHERE id = $1 RETURNING expires_at > clock_timestamp() AS unexpired
      `, [id, transactionId, messageId]);
      return result.rows[0]?.unexpired === true;
    });
  }

  async markOtpOutcome(id: string, phoneHash: string, state: 'unknown' | 'failed', reason: SmsFailureReason): Promise<OtpDeliveryState> {
    return this.database.transaction(async client => {
      const row = await lockedDelivery(client, id, phoneHash);
      if (!row) return state;
      if (row.delivery_status !== 'pending' && row.delivery_status !== 'unknown') return row.delivery_status;
      await client.query(`
        UPDATE otp_verification SET delivery_status = $2, delivery_error_code = $3,
          failed_at = CASE WHEN $2 = 'failed' THEN COALESCE(failed_at, clock_timestamp()) ELSE failed_at END
        WHERE id = $1
      `, [id, state, reason]);
      return state;
    });
  }

  async applySmsEvent(event: SmsDeliveryEvent): Promise<'applied' | 'ignored' | 'conflict'> {
    return this.database.transaction(async client => {
      // Find the lock key without locking the row: every OTP writer takes phone -> row.
      const identity = (await client.query<{ phone_number_hash: string }>(
        'SELECT phone_number_hash FROM otp_verification WHERE id = $1 AND provider = $2',
        [event.deliveryId, 'sweego'],
      )).rows[0];
      if (!identity) return 'ignored'; // Expired/purged or unrelated campaign: no resurrection.
      const row = await lockedDelivery(client, event.deliveryId, identity.phone_number_hash);
      if (!row) return 'ignored';
      if (!matchesReceipt(row, event.messageId, event.transactionId)) return 'conflict';
      if (row.delivery_status === 'failed' || (row.delivery_status === 'sent' && event.type === 'sms_sent')) return 'ignored';
      if (event.type === 'sms_sent') await activate(client, row);
      await client.query(`
        UPDATE otp_verification SET delivery_status = $2,
          provider_message_id = $3, provider_transaction_id = COALESCE(provider_transaction_id, $4),
          sent_at = CASE WHEN $2 = 'sent' THEN COALESCE(sent_at, clock_timestamp()) ELSE sent_at END,
          provider_sent_at = CASE WHEN $2 = 'sent' THEN COALESCE(provider_sent_at, clock_timestamp()) ELSE provider_sent_at END,
          failed_at = CASE WHEN $2 = 'failed' THEN COALESCE(failed_at, clock_timestamp()) ELSE failed_at END,
          delivery_error_code = CASE WHEN $2 = 'failed' THEN 'provider_undelivered' ELSE NULL END,
          last_webhook_at = clock_timestamp()
        WHERE id = $1
      `, [event.deliveryId, event.type === 'sms_sent' ? 'sent' : 'failed', event.messageId, event.transactionId ?? null]);
      return 'applied';
    });
  }

  async consumeOtp(phoneHash: string, otpHash: string): Promise<boolean> {
    return this.database.transaction(async client => {
      await lockPhone(client, phoneHash);
      const result = await client.query(`
        UPDATE otp_verification SET used = true
        WHERE phone_number_hash = $1 AND otp_hash = $2
          AND delivery_status IN ('accepted', 'sent') AND used = false AND expires_at > clock_timestamp()
        RETURNING id
      `, [phoneHash, otpHash]);
      return result.rowCount === 1;
    });
  }

  async statusSnapshot(): Promise<OtpDeliverySnapshot> {
    const row = (await this.database.query<{
      pending: number; accepted: number; sent: number; failed: number; unknown: number;
      awaiting_callback: number; oldest_unresolved_age_seconds: number | null;
      average_acceptance_ms: number | null; average_sent_callback_ms: number | null; average_failure_ms: number | null;
    }>(`
      SELECT count(*) FILTER (WHERE state = 'pending')::int AS pending,
        count(*) FILTER (WHERE state = 'accepted')::int AS accepted,
        count(*) FILTER (WHERE state = 'sent')::int AS sent,
        count(*) FILTER (WHERE state = 'failed')::int AS failed,
        count(*) FILTER (WHERE state = 'unknown')::int AS unknown,
        count(*) FILTER (WHERE state = 'accepted' AND last_webhook_at IS NULL)::int AS awaiting_callback,
        max(EXTRACT(EPOCH FROM (clock_timestamp() - created_at)))
          FILTER (WHERE state IN ('pending', 'unknown', 'accepted'))::float8 AS oldest_unresolved_age_seconds,
        avg(EXTRACT(EPOCH FROM (sent_at - created_at)) * 1000)::float8 AS average_acceptance_ms,
        avg(EXTRACT(EPOCH FROM (provider_sent_at - created_at)) * 1000)::float8 AS average_sent_callback_ms,
        avg(EXTRACT(EPOCH FROM (failed_at - created_at)) * 1000)::float8 AS average_failure_ms
      FROM (SELECT *, CASE WHEN delivery_status = 'pending' AND settlement_deadline <= clock_timestamp()
          THEN 'unknown' ELSE delivery_status END AS state FROM otp_verification
        WHERE expires_at > clock_timestamp()) deliveries
    `)).rows[0]!;
    const { pending, accepted, sent, failed, unknown, ...timing } = row;
    return { states: { pending, accepted, sent, failed, unknown }, ...timing,
      retention: 'otp_expiry', handset_delivery: 'not_confirmed' };
  }
}

async function lockPhone(client: PoolClient, phoneHash: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [phoneHash]);
}

async function lockedDelivery(client: PoolClient, id: string, phoneHash: string): Promise<DeliveryRow | undefined> {
  await lockPhone(client, phoneHash);
  return (await client.query<DeliveryRow>(`
    SELECT id, phone_number_hash, delivery_status, provider_message_id, provider_transaction_id, attempt_number, used
    FROM otp_verification WHERE id = $1 AND phone_number_hash = $2 FOR UPDATE
  `, [id, phoneHash])).rows[0];
}

function matchesReceipt(row: DeliveryRow, messageId: string, transactionId?: string): boolean {
  return (!row.provider_message_id || row.provider_message_id === messageId)
    && (!row.provider_transaction_id || !transactionId || row.provider_transaction_id === transactionId);
}

async function activate(client: PoolClient, row: DeliveryRow): Promise<void> {
  if (row.used) return;
  // A consumed newer OTP is still a supersession barrier; a late callback cannot reactivate an ancestor.
  await client.query(`
    UPDATE otp_verification SET used = true WHERE id = $1 AND (
      expires_at <= clock_timestamp() OR EXISTS (
        SELECT 1 FROM otp_verification WHERE phone_number_hash = $2 AND attempt_number > $3 AND sent_at IS NOT NULL
      ))
  `, [row.id, row.phone_number_hash, row.attempt_number]);
  await client.query(`
    UPDATE otp_verification SET used = true
    WHERE phone_number_hash = $1 AND attempt_number < $2 AND used = false
      AND EXISTS (SELECT 1 FROM otp_verification WHERE id = $3 AND used = false)
  `, [row.phone_number_hash, row.attempt_number, row.id]);
}
