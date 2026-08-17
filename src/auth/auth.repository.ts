import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { Account, NewRefreshToken, StoredRefreshToken } from './auth.models';

type CreateAccountInput = { userId: string; role: 'user' | 'superadmin'; phoneHash: string; encryptedPhone: Buffer };
type BeginOtpDeliveryInput = {
  id: string;
  phoneHash: string;
  otpHash: string;
  idempotencyKey: string;
  expiresAt: Date;
  staleBefore: Date;
};
export type OtpDeliveryStart =
  | { state: 'created' | 'pending' | 'sent' | 'failed'; id: string }
  | { state: 'conflict' };

const SUPERADMIN_BOOTSTRAP_LOCK = 91_104_202;

@Injectable()
export class AuthRepository {
  constructor(private readonly database: DatabaseService) {}

  async beginOtpDelivery(input: BeginOtpDeliveryInput): Promise<OtpDeliveryStart> {
    const inserted = await this.database.query<{ id: string }>(`
      INSERT INTO otp_verification (
        id, phone_number_hash, otp_hash, expires_at, idempotency_key, delivery_status, provider
      )
      VALUES ($1, $2, $3, $4, $5, 'pending', 'sweego')
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING id
    `, [input.id, input.phoneHash, input.otpHash, input.expiresAt, input.idempotencyKey]);
    if (inserted.rows[0]) return { state: 'created', id: inserted.rows[0].id };

    await this.database.query(`
      UPDATE otp_verification
      SET delivery_status = 'failed', delivery_error_code = 'delivery_unknown'
      WHERE idempotency_key = $1
        AND phone_number_hash = $2
        AND delivery_status = 'pending'
        AND created_at <= $3
    `, [input.idempotencyKey, input.phoneHash, input.staleBefore]);

    const existing = (await this.database.query<{
      id: string;
      phone_number_hash: string;
      delivery_status: 'pending' | 'sent' | 'failed';
    }>(`
      SELECT id, phone_number_hash, delivery_status
      FROM otp_verification
      WHERE idempotency_key = $1
    `, [input.idempotencyKey])).rows[0];
    if (!existing) throw new Error('OTP idempotency record disappeared');
    if (existing.phone_number_hash !== input.phoneHash) return { state: 'conflict' };
    return { state: existing.delivery_status, id: existing.id };
  }

  async markOtpSent(id: string, phoneHash: string, transactionId: string, messageId: string): Promise<boolean> {
    return this.database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [phoneHash]);
      const pending = await client.query<{ id: string }>(`
        SELECT id FROM otp_verification
        WHERE id = $1
          AND phone_number_hash = $2
          AND delivery_status = 'pending'
          AND expires_at > clock_timestamp()
        FOR UPDATE
      `, [id, phoneHash]);
      if (!pending.rows[0]) return false;

      await client.query(`
        UPDATE otp_verification
        SET used = true
        WHERE phone_number_hash = $1
          AND id <> $2
          AND delivery_status = 'sent'
          AND used = false
      `, [phoneHash, id]);
      const updated = await client.query(`
        UPDATE otp_verification
        SET delivery_status = 'sent',
            provider_transaction_id = $2,
            provider_message_id = $3,
            sent_at = clock_timestamp()
        WHERE id = $1 AND delivery_status = 'pending'
      `, [id, transactionId, messageId]);
      return updated.rowCount === 1;
    });
  }

  async markOtpFailed(id: string, reason: string): Promise<void> {
    await this.database.query(`
      UPDATE otp_verification
      SET delivery_status = 'failed', delivery_error_code = $2
      WHERE id = $1 AND delivery_status = 'pending'
    `, [id, reason]);
  }

  async consumeOtp(phoneHash: string, otpHash: string): Promise<boolean> {
    const result = await this.database.query<{ id: string }>(`
      UPDATE otp_verification SET used = true
      WHERE id = (
        SELECT id FROM otp_verification
        WHERE phone_number_hash = $1
          AND otp_hash = $2
          AND delivery_status = 'sent'
          AND used = false
          AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1
      ) AND used = false AND expires_at > now()
      RETURNING id
    `, [phoneHash, otpHash]);
    return !!result.rows[0];
  }

  async findAccountByPhoneHash(phoneHash: string): Promise<Account | undefined> {
    return (await this.database.query<Account>(`
      SELECT user_id, role, is_banned FROM user_account WHERE phone_number_hash = $1 AND deleted_at IS NULL
    `, [phoneHash])).rows[0];
  }

  async findAccountById(userId: string): Promise<Account | undefined> {
    return (await this.database.query<Account>(`
      SELECT user_id, role, is_banned FROM user_account WHERE user_id = $1 AND deleted_at IS NULL
    `, [userId])).rows[0];
  }

  async createAccount(account: CreateAccountInput): Promise<Account> {
    return this.database.transaction(async (client) => {
      const tombstone = await client.query<{ blocked: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM account_tombstone
          WHERE phone_number_hash = $1 AND expires_at > clock_timestamp()
        ) AS blocked
      `, [account.phoneHash]);
      if (tombstone.rows[0]?.blocked) throw new AccountTombstoneError();
      await client.query(`
        INSERT INTO user_account (user_id, role, phone_number_hash, phone_number_encrypted)
        VALUES ($1, $2, $3, $4)
      `, [account.userId, account.role, account.phoneHash, account.encryptedPhone]);
      return { user_id: account.userId, role: account.role, is_banned: false };
    });
  }

  async createDevelopmentSuperadmin(account: Omit<CreateAccountInput, 'role'>): Promise<Account | undefined> {
    return this.database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [SUPERADMIN_BOOTSTRAP_LOCK]);
      const existing = await client.query<{ user_id: string }>(`SELECT user_id FROM user_account WHERE role = 'superadmin' AND deleted_at IS NULL LIMIT 1`);
      if (existing.rows[0]) return undefined;
      await client.query(`
        INSERT INTO user_account (user_id, role, phone_number_hash, phone_number_encrypted)
        VALUES ($1, 'superadmin', $2, $3)
      `, [account.userId, account.phoneHash, account.encryptedPhone]);
      return { user_id: account.userId, role: 'superadmin', is_banned: false };
    });
  }

  async findRefreshToken(jti: string): Promise<StoredRefreshToken | undefined> {
    return (await this.database.query<StoredRefreshToken>(`
      SELECT id, user_id, token_hash, jti, revoked, expires_at FROM refresh_tokens WHERE jti = $1
    `, [jti])).rows[0];
  }

  async insertRefreshToken(userId: string, token: NewRefreshToken): Promise<void> {
    await this.database.query(`
      INSERT INTO refresh_tokens (id, user_id, token_hash, jti, revoked, expires_at, created_at)
      VALUES ($1, $2, $3, $4, false, $5, $6)
    `, [token.id, userId, token.hash, token.jti, token.expiresAt, token.createdAt]);
  }

  async rotateRefreshToken(currentJti: string, currentHash: string, next: NewRefreshToken): Promise<string | undefined> {
    return this.database.transaction(async (client) => {
      const locked = await client.query<StoredRefreshToken>(`
        SELECT id, user_id, token_hash, jti, revoked, expires_at FROM refresh_tokens WHERE jti = $1 FOR UPDATE
      `, [currentJti]);
      const current = locked.rows[0];
      if (!current || current.token_hash !== currentHash || current.revoked || new Date(current.expires_at).getTime() <= Date.now()) return undefined;

      const revoked = await client.query(`
        UPDATE refresh_tokens SET revoked = true WHERE jti = $1 AND revoked = false
      `, [currentJti]);
      if (revoked.rowCount !== 1) return undefined;
      await client.query(`
        INSERT INTO refresh_tokens (id, user_id, token_hash, jti, revoked, expires_at, created_at)
        VALUES ($1, $2, $3, $4, false, $5, $6)
      `, [next.id, current.user_id, next.hash, next.jti, next.expiresAt, next.createdAt]);
      return current.user_id;
    });
  }

  async revokeRefreshToken(ownerId: string, jti: string, hash: string): Promise<boolean> {
    const result = await this.database.query(`
      UPDATE refresh_tokens SET revoked = true
      WHERE jti = $1 AND user_id = $2 AND token_hash = $3 AND revoked = false AND expires_at > now()
    `, [jti, ownerId, hash]);
    return result.rowCount === 1;
  }
}

export class AccountTombstoneError extends Error {
  constructor() {
    super('account tombstone is active');
  }
}
