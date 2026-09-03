import { createHash, randomUUID } from 'node:crypto';
import type { Queryable } from '../database/database.service';
import { BILLING_NOTIFICATION_ELIGIBLE_SQL, type BillingNotificationIntent } from './notification-billing';

export type NotificationIntent =
  | { type: 'new_match'; matchId: string }
  | { type: 'new_message'; matchId: string; messageId: string; senderId: string }
  | BillingNotificationIntent;

/** Must use the caller's business transaction. Network delivery belongs to the worker. */
export async function enqueueNotification(
  database: Queryable,
  userId: string,
  sourceId: string,
  intent: NotificationIntent,
): Promise<void> {
  const key = createHash('sha256').update(JSON.stringify([intent.type, sourceId, userId])).digest('hex');
  // Construct an allowlist, never spread a message or provider object into storage.
  const payload = intent.type === 'new_message'
    ? { match_id: intent.matchId, message_id: intent.messageId, sender_id: intent.senderId }
    : intent.type === 'new_match' ? { match_id: intent.matchId } : {};
  await database.query(`
    WITH account AS MATERIALIZED (
      SELECT user_id FROM user_account
      WHERE user_id = $2 AND deleted_at IS NULL AND NOT is_banned
      FOR SHARE
    ), candidate AS (
      SELECT $1::uuid AS id, user_id, $3::text AS type, $4::jsonb AS payload,
        $5::text AS deduplication_key, $6::text AS billing_reference,
        $7::timestamptz AS billing_trial_ends_at
      FROM account
    ), created_notification AS (
      INSERT INTO notification (id, user_id, type, payload, deduplication_key, billing_reference, billing_trial_ends_at)
      SELECT id, user_id, type, payload, deduplication_key, billing_reference, billing_trial_ends_at
      FROM candidate n
      WHERE n.type IN ('new_match', 'new_message') OR (${BILLING_NOTIFICATION_ELIGIBLE_SQL})
      ON CONFLICT (deduplication_key) DO NOTHING
      RETURNING id, user_id
    ), targets AS MATERIALIZED (
      SELECT uuid_generate_v4() AS id, n.id AS notification_id, d.id AS device_id, d.session_id
      FROM created_notification n JOIN device_token d ON d.user_id = n.user_id
      LEFT JOIN refresh_token_family session ON session.id = d.session_id
      WHERE d.session_id IS NULL OR (session.revoked_at IS NULL AND session.expires_at > clock_timestamp())
    ), jobs AS (
      INSERT INTO outbox_event (id, event_type, aggregate_id)
      SELECT id, 'notification.push', id FROM targets
      RETURNING id
    )
    INSERT INTO notification_push_delivery (id, notification_id, device_id, session_id)
    SELECT targets.id, notification_id, device_id, session_id
    FROM targets JOIN jobs ON jobs.id = targets.id
  `, [randomUUID(), userId, intent.type, JSON.stringify(payload), key,
    intent.type === 'billing_payment_failed' ? intent.invoiceId
      : intent.type === 'subscription_trial_ending' ? intent.subscriptionId : null,
    intent.type === 'subscription_trial_ending' ? intent.trialEndsAt : null,
  ]);
}
