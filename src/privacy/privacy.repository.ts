import { Injectable } from '@nestjs/common';
import type { Queryable } from '../database/database.service';
import { DatabaseService } from '../database/database.service';
import type { BlockedUser, DataAccessLogRow, DataRequestStatus, DataRequestType, DataSubjectRequestRow, PortableUserData, PrivacyMaintenanceResult } from './privacy.models';

const ENDED_MATCH_RETENTION_DAYS = 30;
const PRIVACY_MAINTENANCE_LOCK = 61_202_608;

@Injectable()
export class PrivacyRepository {
  constructor(private readonly database: DatabaseService) {}

  async createRequest(userId: string, type: DataRequestType): Promise<DataSubjectRequestRow | undefined> {
    return (await this.database.query<DataSubjectRequestRow>(`
      INSERT INTO data_subject_request (user_id, type)
      VALUES ($1, $2)
      ON CONFLICT (user_id, type) WHERE status IN ('pending', 'in_progress') DO NOTHING
      RETURNING id, user_id, type, status, requested_at, completed_at, handled_by
    `, [userId, type])).rows[0];
  }

  async requestsForUser(userId: string): Promise<DataSubjectRequestRow[]> {
    return (await this.database.query<DataSubjectRequestRow>(`
      SELECT id, user_id, type, status, requested_at, completed_at, handled_by
      FROM data_subject_request WHERE user_id = $1
      ORDER BY requested_at DESC, id DESC
    `, [userId])).rows;
  }

  async requestsForAdmin(status: DataRequestStatus | undefined): Promise<DataSubjectRequestRow[]> {
    return (await this.database.query<DataSubjectRequestRow>(`
      SELECT id, user_id, type, status, requested_at, completed_at, handled_by, notes
      FROM data_subject_request
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY requested_at, id
      LIMIT 500
    `, [status ?? null])).rows;
  }

  async updateRequest(
    requestId: string,
    status: Exclude<DataRequestStatus, 'pending'>,
    adminId: string,
    adminRole: string,
    notes: string | null,
    beforeErasure: (userId: string) => Promise<void>,
  ): Promise<'updated' | 'not_found' | 'invalid_transition'> {
    return this.database.transaction(async (client) => {
      const locked = await client.query<DataSubjectRequestRow>(`
        SELECT id, user_id, type, status, requested_at, completed_at, handled_by, notes
        FROM data_subject_request WHERE id = $1 FOR UPDATE
      `, [requestId]);
      const request = locked.rows[0];
      if (!request) return 'not_found';
      const allowed = request.status === 'pending'
        ? status === 'in_progress' || status === 'rejected'
        : request.status === 'in_progress' && (status === 'completed' || status === 'rejected');
      if (!allowed) return 'invalid_transition';
      await client.query(`
        UPDATE data_subject_request
        SET status = $2, handled_by = $3, notes = $4,
          completed_at = CASE WHEN $2 IN ('completed', 'rejected') THEN clock_timestamp() ELSE NULL END
        WHERE id = $1
      `, [requestId, status, adminId, notes]);
      await client.query(`
        INSERT INTO data_access_log (accessed_user_id, accessor_id, accessor_role, action, reason)
        VALUES ($1, $2, $3, 'admin_review_dsr', $4)
      `, [request.user_id, adminId, adminRole, `DSR ${request.type} moved to ${status}`]);
      if (request.type === 'erasure' && status === 'completed') {
        await beforeErasure(request.user_id);
        await client.query('DELETE FROM account_deletion_token WHERE user_id = $1', [request.user_id]);
        await client.query('SELECT fct_anonymize_user($1)', [request.user_id]);
      }
      return 'updated';
    });
  }

  async exportUserData(userId: string): Promise<PortableUserData> {
    return this.database.transaction(async (client) => {
      const account = (await client.query(`
        SELECT user_id, role, is_banned, deleted_at, anonymized_at, created_at
        FROM user_account WHERE user_id = $1
      `, [userId])).rows[0];
      // A single PostgreSQL client executes one query at a time. Keeping these
      // reads sequential also preserves their shared transactional snapshot.
      const profile = await client.query(`
        SELECT profile.firstname, profile.birthdate, profile.sex, profile.bio,
          photo.object_key AS photo
        FROM user_profile AS profile
        LEFT JOIN user_photo AS photo
          ON photo.user_id = profile.user_id AND photo.status = 'ready'
        WHERE profile.user_id = $1
      `, [userId]);
      const preferences = await client.query('SELECT min_age, max_age, max_distance_km, looking_for FROM user_preferences WHERE user_id = $1', [userId]);
      const traits = await client.query(`SELECT trait.id, trait.name FROM trait JOIN user_trait ON user_trait.trait_id = trait.id WHERE user_trait.user_id = $1 ORDER BY trait.name`, [userId]);
      const profileAnswers = await client.query(`
        SELECT answer.question_id, question.code, question.prompt AS question,
          answer.answer, answer.position
        FROM user_profile_answer AS answer
        JOIN profile_question AS question ON question.id = answer.question_id
        WHERE answer.user_id = $1 ORDER BY answer.position
      `, [userId]);
      const consents = await client.query(`SELECT consent_type, granted, document_version, granted_at, withdrawn_at FROM user_consent WHERE user_id = $1 ORDER BY event_sequence`, [userId]);
      const matches = await client.query(`SELECT id, user1_id, user2_id, status, expires_at, created_at, last_message_at FROM match_init WHERE user1_id = $1 OR user2_id = $1 ORDER BY created_at`, [userId]);
      const messages = await client.query(`SELECT id, match_id, content, created_at, read_at FROM chat_message WHERE sender_id = $1 ORDER BY created_at`, [userId]);
      const reports = await client.query(`SELECT id, reported_id, match_id, reason, description, status, created_at, resolved_at FROM user_report WHERE reporter_id = $1 ORDER BY created_at`, [userId]);
      const blocks = await client.query(`SELECT blocked_id, created_at FROM user_block WHERE blocker_id = $1 ORDER BY created_at`, [userId]);
      const subscription = await client.query(`
        SELECT plan, provider, provider_subscription_id, provider_price_id, billing_period, status,
          cancel_at_period_end, current_period_starts_at, current_period_ends_at,
          trial_ends_at, canceled_at, provider_event_created_at, updated_at
        FROM user_subscription WHERE user_id = $1
      `, [userId]);
      const billingInvoices = await client.query(`
        SELECT stripe_invoice_id, stripe_subscription_id, status, currency, amount_due,
          amount_paid, amount_remaining, period_starts_at, period_ends_at, paid_at,
          created_at, provider_event_created_at
        FROM billing_invoice WHERE user_id = $1 ORDER BY created_at
      `, [userId]);
      await client.query(`
        INSERT INTO data_access_log (accessed_user_id, accessor_id, accessor_role, action, reason)
        VALUES ($1, $1, 'user', 'export_data', 'Self-service data export')
      `, [userId]);
      return {
        exported_at: new Date().toISOString(),
        account: account ?? null,
        profile: profile.rows[0] ?? null,
        preferences: preferences.rows[0] ?? null,
        traits: traits.rows,
        profile_answers: profileAnswers.rows,
        legal_choices: consents.rows,
        matches: matches.rows,
        authored_messages: messages.rows,
        submitted_reports: reports.rows,
        blocked_users: blocks.rows,
        subscription: subscription.rows[0] ?? null,
        billing_invoices: billingInvoices.rows,
      };
    });
  }

  async blockUser(blockerId: string, blockedId: string): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const target = await client.query<{ user_id: string }>(`
        SELECT user_id FROM user_account WHERE user_id = $1 AND deleted_at IS NULL
      `, [blockedId]);
      if (!target.rows[0]) return false;
      await client.query(`
        INSERT INTO user_block (blocker_id, blocked_id) VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `, [blockerId, blockedId]);
      await client.query(`
        UPDATE match_init
        SET status = 'ended', purge_after = clock_timestamp() + ($3 * INTERVAL '1 day')
        WHERE ((user1_id = $1 AND user2_id = $2) OR (user1_id = $2 AND user2_id = $1))
          AND status IN ('active', 'awaiting_continuation', 'confirmed')
      `, [blockerId, blockedId, ENDED_MATCH_RETENTION_DAYS]);
      return true;
    });
  }

  async unblockUser(blockerId: string, blockedId: string): Promise<void> {
    await this.database.query('DELETE FROM user_block WHERE blocker_id = $1 AND blocked_id = $2', [blockerId, blockedId]);
  }

  async blockedUsers(blockerId: string): Promise<BlockedUser[]> {
    return (await this.database.query<BlockedUser>(`
      SELECT block.blocked_id AS user_id, profile.firstname, NULL::text AS photo, block.created_at AS blocked_at
      FROM user_block AS block
      LEFT JOIN user_profile AS profile ON profile.user_id = block.blocked_id
      WHERE block.blocker_id = $1
      ORDER BY block.created_at DESC
    `, [blockerId])).rows;
  }

  async accessLogs(accessedUserId: string): Promise<DataAccessLogRow[]> {
    return (await this.database.query<DataAccessLogRow>(`
      SELECT id, accessed_user_id, accessor_id, accessor_role, action, reason, accessed_at
      FROM data_access_log WHERE accessed_user_id = $1
      ORDER BY accessed_at DESC, id DESC LIMIT 500
    `, [accessedUserId])).rows;
  }

  async runMaintenanceAsLeader(now: Date, batchSize: number): Promise<PrivacyMaintenanceResult | undefined> {
    return this.database.transaction(async (client) => {
      const lock = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS acquired', [PRIVACY_MAINTENANCE_LOCK]);
      if (!lock.rows[0]?.acquired) return undefined;
      return this.runMaintenance(client, now, batchSize);
    });
  }

  async runMaintenance(database: Queryable, now: Date, batchSize: number): Promise<PrivacyMaintenanceResult> {
    const stalePresences = await database.query(`
      WITH stale AS (
        SELECT user_id FROM user_presence
        WHERE is_location_fresh = true AND updated_at <= $1::timestamptz - INTERVAL '1 hour'
        ORDER BY updated_at LIMIT $2
      )
      UPDATE user_presence SET is_location_fresh = false
      WHERE user_id IN (SELECT user_id FROM stale)
    `, [now, batchSize]);
    const expiredPresences = await database.query(`DELETE FROM user_presence WHERE user_id IN (
      SELECT user_id FROM user_presence WHERE updated_at <= $1::timestamptz - INTERVAL '24 hours'
      ORDER BY updated_at LIMIT $2
    )`, [now, batchSize]);
    const expiredOtps = await database.query(`DELETE FROM otp_verification WHERE id IN (
      SELECT id FROM otp_verification WHERE expires_at <= $1::timestamptz ORDER BY expires_at LIMIT $2
    )`, [now, batchSize]);
    const expiredRefreshTokens = await database.query(`DELETE FROM refresh_tokens WHERE id IN (
      SELECT id FROM refresh_tokens WHERE expires_at <= $1::timestamptz ORDER BY expires_at LIMIT $2
    )`, [now, batchSize]);
    const expiredNotifications = await database.query(`DELETE FROM notification WHERE id IN (
      SELECT id FROM notification WHERE expires_at <= $1::timestamptz ORDER BY expires_at LIMIT $2
    )`, [now, batchSize]);
    const expiredConsents = await database.query(`DELETE FROM user_consent WHERE id IN (
      SELECT id FROM user_consent WHERE withdrawn_at IS NOT NULL AND withdrawn_at <= $1::timestamptz - INTERVAL '5 years'
      ORDER BY withdrawn_at LIMIT $2
    )`, [now, batchSize]);
    const expiredDataSubjectRequests = await database.query(`DELETE FROM data_subject_request WHERE id IN (
      SELECT id FROM data_subject_request
      WHERE status IN ('completed', 'rejected') AND completed_at IS NOT NULL AND completed_at <= $1::timestamptz - INTERVAL '5 years'
      ORDER BY completed_at LIMIT $2
    )`, [now, batchSize]);
    const expiredDataAccessLogs = await database.query(`DELETE FROM data_access_log WHERE id IN (
      SELECT id FROM data_access_log WHERE accessed_at <= $1::timestamptz - INTERVAL '1 year' ORDER BY accessed_at LIMIT $2
    )`, [now, batchSize]);
    const expiredReports = await database.query(`DELETE FROM user_report WHERE id IN (
      SELECT id FROM user_report
      WHERE status IN ('reviewed', 'dismissed') AND resolved_at IS NOT NULL AND resolved_at <= $1::timestamptz - INTERVAL '3 years'
      ORDER BY resolved_at LIMIT $2
    )`, [now, batchSize]);
    const expiredTombstones = await database.query(`DELETE FROM account_tombstone WHERE phone_number_hash IN (
      SELECT phone_number_hash FROM account_tombstone WHERE expires_at <= $1::timestamptz ORDER BY expires_at LIMIT $2
    )`, [now, batchSize]);
    const expiredDeletionTokens = await database.query(`DELETE FROM account_deletion_token WHERE id IN (
      SELECT id FROM account_deletion_token WHERE expires_at <= $1::timestamptz ORDER BY expires_at LIMIT $2
    )`, [now, batchSize]);
    return {
      stale_presences: stalePresences.rowCount ?? 0,
      expired_presences: expiredPresences.rowCount ?? 0,
      expired_otps: expiredOtps.rowCount ?? 0,
      expired_refresh_tokens: expiredRefreshTokens.rowCount ?? 0,
      expired_notifications: expiredNotifications.rowCount ?? 0,
      expired_consents: expiredConsents.rowCount ?? 0,
      expired_data_subject_requests: expiredDataSubjectRequests.rowCount ?? 0,
      expired_data_access_logs: expiredDataAccessLogs.rowCount ?? 0,
      expired_reports: expiredReports.rowCount ?? 0,
      expired_account_tombstones: expiredTombstones.rowCount ?? 0,
      expired_account_deletion_tokens: expiredDeletionTokens.rowCount ?? 0,
    };
  }
}
