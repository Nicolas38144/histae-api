import { Injectable } from '@nestjs/common';
import type { Queryable } from '../database/database.service';
import { DatabaseService } from '../database/database.service';
import { enqueueAccountErasure } from './erasure-enqueue';
import type { KeysetCursor } from '../common/pagination';
import type {
  BlockedUser,
  CursorDataAccessLogRow,
  CursorDataSubjectRequestRow,
  DataRequestStatus,
  DataRequestType,
  DataSubjectRequestRow,
  PrivacyMaintenanceResult,
} from './privacy.models';

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

  async requestsForAdmin(
    status: DataRequestStatus | undefined,
    limit: number,
    offset: number,
    cursor?: KeysetCursor,
  ): Promise<CursorDataSubjectRequestRow[]> {
    return (await this.database.query<CursorDataSubjectRequestRow>(`
      SELECT request.id, request.user_id, request.type, request.status, request.requested_at,
        request.completed_at, request.handled_by, request.notes,
        to_char(request.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
        CASE WHEN erasure.request_id IS NOT NULL THEN jsonb_build_object(
          'step', erasure.step, 'updated_at', erasure.updated_at,
          'event_id', event.id, 'status', event.status, 'attempts', COALESCE(event.attempts, 0),
          'last_error_code', event.last_error_code) END AS erasure
      FROM data_subject_request request
      LEFT JOIN account_erasure erasure ON erasure.request_id = request.id
      LEFT JOIN outbox_event event ON event.aggregate_id = request.id AND event.event_type = 'account.erase'
      WHERE ($1::text IS NULL OR request.status = $1)
        AND ($4::timestamptz IS NULL OR (request.requested_at, request.id) < ($4::timestamptz, $5::uuid))
      ORDER BY request.requested_at DESC, request.id DESC
      LIMIT $2 OFFSET $3
    `, [status ?? null, limit, offset, cursor?.at ?? null, cursor?.id ?? null])).rows;
  }

  async updateRequest(
    requestId: string,
    status: Exclude<DataRequestStatus, 'pending'>,
    adminId: string,
    adminRole: string,
    notes: string | null,
  ): Promise<'updated' | 'erasure_scheduled' | 'not_found' | 'invalid_transition'> {
    return this.database.transaction(async (client) => {
      const owner = (await client.query<{ user_id: string }>(
        'SELECT user_id FROM data_subject_request WHERE id = $1', [requestId],
      )).rows[0];
      if (!owner) return 'not_found';
      // Same lock order as self-service acceptance and final anonymization.
      await client.query('SELECT user_id FROM user_account WHERE user_id = $1 FOR UPDATE', [owner.user_id]);
      const locked = await client.query<DataSubjectRequestRow>(`
        SELECT id, user_id, type, status, requested_at, completed_at, handled_by, notes
        FROM data_subject_request WHERE id = $1 FOR UPDATE
      `, [requestId]);
      const request = locked.rows[0];
      if (!request) return 'not_found';
      const workflow = (await client.query('SELECT request_id FROM account_erasure WHERE request_id = $1', [requestId])).rows[0];
      if (workflow) return request.status === 'in_progress' && status === 'completed'
        ? 'erasure_scheduled' : 'invalid_transition';
      const allowed = request.status === 'pending'
        ? status === 'in_progress' || status === 'rejected'
        : request.status === 'in_progress' && (status === 'completed' || status === 'rejected');
      if (!allowed) return 'invalid_transition';
      const scheduling = request.type === 'erasure' && status === 'completed';
      const storedStatus = scheduling ? 'in_progress' : status;
      await client.query(`
        UPDATE data_subject_request
        SET status = $2, handled_by = $3, notes = $4,
          completed_at = CASE WHEN $2 IN ('completed', 'rejected') THEN clock_timestamp() ELSE NULL END
        WHERE id = $1
      `, [requestId, storedStatus, adminId, notes]);
      await client.query(`
        INSERT INTO data_access_log (accessed_user_id, accessor_id, accessor_role, action, reason)
        VALUES ($1, $2, $3, 'admin_review_dsr', $4)
      `, [request.user_id, adminId, adminRole, scheduling ? 'DSR erasure scheduled' : `DSR ${request.type} moved to ${status}`]);
      if (scheduling) {
        await enqueueAccountErasure(client, request.user_id, requestId);
        return 'erasure_scheduled';
      }
      return 'updated';
    });
  }

  async recordSelfExport(userId: string): Promise<void> {
    await this.database.query(`
      INSERT INTO data_access_log (accessed_user_id, accessor_id, accessor_role, action, reason)
      VALUES ($1, $1, 'user', 'export_data', 'Self-service data export')
    `, [userId]);
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
        AND EXISTS (SELECT 1 FROM user_account WHERE user_id = block.blocked_id AND deleted_at IS NULL)
      WHERE block.blocker_id = $1
      ORDER BY block.created_at DESC
    `, [blockerId])).rows;
  }

  async accessLogs(
    accessedUserId: string,
    limit: number,
    offset: number,
    cursor?: KeysetCursor,
  ): Promise<CursorDataAccessLogRow[]> {
    return (await this.database.query<CursorDataAccessLogRow>(`
      SELECT id, accessed_user_id, accessor_id, accessor_role, action, reason, accessed_at,
        to_char(accessed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM data_access_log WHERE accessed_user_id = $1
        AND ($4::timestamptz IS NULL OR (accessed_at, id) < ($4::timestamptz, $5::uuid))
      ORDER BY accessed_at DESC, id DESC LIMIT $2 OFFSET $3
    `, [accessedUserId, limit, offset, cursor?.at ?? null, cursor?.id ?? null])).rows;
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
    const expiredSwipes = await database.query(`DELETE FROM swipe_decision WHERE (actor_id, target_id) IN (
      SELECT actor_id, target_id FROM swipe_decision WHERE expires_at <= $1::timestamptz
      ORDER BY expires_at, actor_id, target_id LIMIT $2
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
    const expiredAdminChallenges = await database.query(`DELETE FROM admin_webauthn_challenge WHERE id IN (
      SELECT id FROM (
        (SELECT id, expires_at FROM admin_webauthn_challenge
        WHERE consumed_at IS NOT NULL
        ORDER BY expires_at, id LIMIT $2)
        UNION ALL
        (SELECT id, expires_at FROM admin_webauthn_challenge
        WHERE consumed_at IS NULL AND expires_at <= $1::timestamptz
        ORDER BY expires_at, id LIMIT $2)
      ) AS candidates
      ORDER BY expires_at, id LIMIT $2
    )`, [now, batchSize]);
    const expiredAdminBootstraps = await database.query(`DELETE FROM admin_webauthn_bootstrap WHERE id IN (
      SELECT id FROM (
        (SELECT id, expires_at FROM admin_webauthn_bootstrap
        WHERE consumed_at IS NOT NULL
        ORDER BY expires_at, id LIMIT $2)
        UNION ALL
        (SELECT id, expires_at FROM admin_webauthn_bootstrap
        WHERE consumed_at IS NULL AND expires_at <= $1::timestamptz
        ORDER BY expires_at, id LIMIT $2)
      ) AS candidates
      ORDER BY expires_at, id LIMIT $2
    )`, [now, batchSize]);
    const expiredAdminSessions = await database.query(`DELETE FROM admin_session WHERE id IN (
      SELECT id FROM (
        (SELECT id, absolute_expires_at AS cleanup_at
        FROM admin_session
        WHERE absolute_expires_at <= $1::timestamptz
        ORDER BY absolute_expires_at, id
        LIMIT $2)
        UNION ALL
        (SELECT id, revoked_at AS cleanup_at
        FROM admin_session
        WHERE revoked_at <= $1::timestamptz - INTERVAL '24 hours'
          AND absolute_expires_at > $1::timestamptz
        ORDER BY revoked_at, id
        LIMIT $2)
      ) AS candidates
      ORDER BY cleanup_at, id LIMIT $2
    )`, [now, batchSize]);
    const expiredAdminAuthEvents = await database.query(`DELETE FROM admin_auth_event WHERE id IN (
      SELECT id FROM admin_auth_event
      WHERE created_at <= $1::timestamptz - INTERVAL '1 year'
      ORDER BY created_at LIMIT $2
    )`, [now, batchSize]);
    const expiredOutboxOperatorActions = await database.query(`DELETE FROM outbox_operator_action WHERE id IN (
      SELECT id FROM outbox_operator_action
      WHERE created_at <= $1::timestamptz - INTERVAL '1 year'
      ORDER BY created_at LIMIT $2
    )`, [now, batchSize]);
    // Delete only empty families, after the bounded token cleanup. A family can
    // have many historical tokens; never cascade an unbounded history in a batch.
    const expiredMobileSessions = await database.query(`DELETE FROM refresh_token_family WHERE id IN (
      SELECT family.id FROM refresh_token_family AS family
      WHERE family.expires_at <= $1::timestamptz
        AND NOT EXISTS (SELECT 1 FROM refresh_tokens WHERE family_id = family.id)
      ORDER BY family.expires_at, family.id LIMIT $2
    )`, [now, batchSize]);
    return {
      stale_presences: stalePresences.rowCount ?? 0,
      expired_presences: expiredPresences.rowCount ?? 0,
      expired_swipes: expiredSwipes.rowCount ?? 0,
      expired_otps: expiredOtps.rowCount ?? 0,
      expired_refresh_tokens: expiredRefreshTokens.rowCount ?? 0,
      expired_notifications: expiredNotifications.rowCount ?? 0,
      expired_consents: expiredConsents.rowCount ?? 0,
      expired_data_subject_requests: expiredDataSubjectRequests.rowCount ?? 0,
      expired_data_access_logs: expiredDataAccessLogs.rowCount ?? 0,
      expired_reports: expiredReports.rowCount ?? 0,
      expired_account_tombstones: expiredTombstones.rowCount ?? 0,
      expired_account_deletion_tokens: expiredDeletionTokens.rowCount ?? 0,
      expired_admin_webauthn_challenges: expiredAdminChallenges.rowCount ?? 0,
      expired_admin_webauthn_bootstraps: expiredAdminBootstraps.rowCount ?? 0,
      expired_admin_sessions: expiredAdminSessions.rowCount ?? 0,
      expired_admin_auth_events: expiredAdminAuthEvents.rowCount ?? 0,
      expired_outbox_operator_actions: expiredOutboxOperatorActions.rowCount ?? 0,
      expired_mobile_sessions: expiredMobileSessions.rowCount ?? 0,
    };
  }
}
