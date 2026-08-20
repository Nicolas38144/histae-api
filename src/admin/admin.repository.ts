import { Injectable } from '@nestjs/common';
import type { KeysetCursor } from '../common/pagination';
import { DatabaseService } from '../database/database.service';
import type { AdminMessageRow, AdminMetrics, AdminUserDetail, AdminUserRow, AdminUserStatus } from './admin.models';

type AdminRole = 'admin' | 'superadmin';

@Injectable()
export class AdminRepository {
  constructor(private readonly database: DatabaseService) {}

  async listUsers(
    status: AdminUserStatus | undefined,
    role: 'user' | 'admin' | 'superadmin' | undefined,
    search: string,
    limit: number,
    offset: number,
    cursor: KeysetCursor | undefined,
    termsVersion: string,
    privacyVersion: string,
  ): Promise<AdminUserRow[]> {
    return (await this.database.query<AdminUserRow>(`
      SELECT account.user_id AS id, account.role, account.is_banned, account.banned_at, account.created_at,
        profile.firstname, profile.birthdate, profile.sex, profile.photo,
        COALESCE(subscription.plan, 'free') AS plan,
        (
          account.role <> 'user' OR (
            EXISTS (
              SELECT 1 FROM user_consent
              WHERE user_id = account.user_id AND consent_type = 'terms_of_service_acceptance'
                AND granted = true AND withdrawn_at IS NULL AND document_version = $8
            ) AND EXISTS (
              SELECT 1 FROM user_consent
              WHERE user_id = account.user_id AND consent_type = 'privacy_notice_acknowledgement'
                AND granted = true AND withdrawn_at IS NULL AND document_version = $9
            )
          )
        ) AS onboarding_complete,
        (SELECT count(*)::int FROM user_report WHERE reported_id = account.user_id) AS reports_received,
        (SELECT count(*)::int FROM match_init WHERE user1_id = account.user_id OR user2_id = account.user_id) AS matches_count,
        to_char(account.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM user_account AS account
      LEFT JOIN user_profile AS profile ON profile.user_id = account.user_id
      LEFT JOIN user_subscription AS subscription ON subscription.user_id = account.user_id
      WHERE account.deleted_at IS NULL
        AND ($1::text IS NULL OR ($1 = 'banned' AND account.is_banned) OR ($1 = 'active' AND NOT account.is_banned))
        AND ($2::text IS NULL OR account.role = $2)
        AND ($3 = '' OR profile.firstname ILIKE '%' || $3 || '%' OR account.user_id::text = $3)
        AND ($6::timestamptz IS NULL OR (account.created_at, account.user_id) < ($6::timestamptz, $7::uuid))
      ORDER BY account.created_at DESC, account.user_id DESC
      LIMIT $4 OFFSET $5
    `, [status ?? null, role ?? null, search, limit, offset, cursor?.at ?? null, cursor?.id ?? null, termsVersion, privacyVersion])).rows;
  }

  async userDetail(
    targetId: string,
    adminId: string,
    adminRole: AdminRole,
    reason: string,
    termsVersion: string,
    privacyVersion: string,
  ): Promise<AdminUserDetail | undefined> {
    return this.database.transaction(async (client) => {
      const account = (await client.query<AdminUserRow & { banned_reason: string | null }>(`
        SELECT account.user_id AS id, account.role, account.is_banned, account.banned_at, account.banned_reason,
          account.created_at, profile.firstname, profile.birthdate, profile.sex, profile.photo,
          COALESCE(subscription.plan, 'free') AS plan,
          (
            account.role <> 'user' OR (
              EXISTS (SELECT 1 FROM user_consent WHERE user_id = account.user_id
                AND consent_type = 'terms_of_service_acceptance' AND granted = true
                AND withdrawn_at IS NULL AND document_version = $2)
              AND EXISTS (SELECT 1 FROM user_consent WHERE user_id = account.user_id
                AND consent_type = 'privacy_notice_acknowledgement' AND granted = true
                AND withdrawn_at IS NULL AND document_version = $3)
            )
          ) AS onboarding_complete,
          (SELECT count(*)::int FROM user_report WHERE reported_id = account.user_id) AS reports_received,
          (SELECT count(*)::int FROM match_init WHERE user1_id = account.user_id OR user2_id = account.user_id) AS matches_count,
          to_char(account.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
        FROM user_account AS account
        LEFT JOIN user_profile AS profile ON profile.user_id = account.user_id
        LEFT JOIN user_subscription AS subscription ON subscription.user_id = account.user_id
        WHERE account.user_id = $1 AND account.deleted_at IS NULL
      `, [targetId, termsVersion, privacyVersion])).rows[0];
      if (!account) return undefined;

      const preferences = (await client.query<AdminUserDetail['preferences'] & Record<string, unknown>>(`
        SELECT min_age, max_age, max_distance_km, looking_for FROM user_preferences WHERE user_id = $1
      `, [targetId])).rows[0] ?? null;
      const traits = (await client.query<{ id: string; name: string }>(`
        SELECT trait.id, trait.name FROM trait
        JOIN user_trait ON user_trait.trait_id = trait.id
        WHERE user_trait.user_id = $1 ORDER BY trait.name, trait.id
      `, [targetId])).rows;
      const consents = (await client.query<AdminUserDetail['consents'][number]>(`
        SELECT DISTINCT ON (consent_type) consent_type, granted, document_version, granted_at AS updated_at
        FROM user_consent WHERE user_id = $1 ORDER BY consent_type, event_sequence DESC
      `, [targetId])).rows;
      const presence = (await client.query<{ is_location_fresh: boolean; updated_at: Date }>(`
        SELECT is_location_fresh, updated_at FROM user_presence WHERE user_id = $1
      `, [targetId])).rows[0] ?? null;

      await client.query(`
        INSERT INTO data_access_log (accessed_user_id, accessor_id, accessor_role, action, reason)
        VALUES ($1, $2, $3, 'view_profile', $4)
      `, [targetId, adminId, adminRole, reason]);

      return {
        user_id: account.id,
        role: account.role,
        is_banned: account.is_banned,
        banned_at: account.banned_at,
        banned_reason: account.banned_reason,
        created_at: account.created_at,
        firstname: account.firstname,
        birthdate: dateOnly(account.birthdate),
        sex: account.sex,
        photo: account.photo,
        plan: account.plan,
        onboarding_complete: account.onboarding_complete,
        reports_received: account.reports_received,
        matches_count: account.matches_count,
        preferences,
        traits,
        consents,
        presence,
      };
    });
  }

  async setUserBan(
    targetId: string,
    isBanned: boolean,
    reason: string,
    adminId: string,
    adminRole: AdminRole,
  ): Promise<'updated' | 'not_found' | 'forbidden'> {
    return this.database.transaction(async (client) => {
      const target = (await client.query<{ role: 'user' | 'admin' | 'superadmin' }>(`
        SELECT role FROM user_account WHERE user_id = $1 AND deleted_at IS NULL FOR UPDATE
      `, [targetId])).rows[0];
      if (!target) return 'not_found';
      if (targetId === adminId || target.role === 'superadmin' || (adminRole === 'admin' && target.role !== 'user')) return 'forbidden';

      await client.query(`
        UPDATE user_account SET is_banned = $2,
          banned_at = CASE WHEN $2 THEN clock_timestamp() ELSE NULL END,
          banned_reason = CASE WHEN $2 THEN $3 ELSE NULL END,
          banned_by = CASE WHEN $2 THEN $4 ELSE NULL END
        WHERE user_id = $1
      `, [targetId, isBanned, reason, adminId]);
      if (isBanned) await client.query('UPDATE refresh_tokens SET revoked = true WHERE user_id = $1 AND revoked = false', [targetId]);
      await client.query(`
        INSERT INTO data_access_log (accessed_user_id, accessor_id, accessor_role, action, reason)
        VALUES ($1, $2, $3, $4, $5)
      `, [targetId, adminId, adminRole, isBanned ? 'admin_ban' : 'admin_unban', reason]);
      return 'updated';
    });
  }

  async metrics(termsVersion: string, privacyVersion: string): Promise<AdminMetrics> {
    const users = (await this.database.query<AdminMetrics['users']>(`
      SELECT count(*)::int AS total,
        count(*) FILTER (WHERE NOT is_banned)::int AS active,
        count(*) FILTER (WHERE is_banned)::int AS banned,
        count(*) FILTER (WHERE created_at >= now() - INTERVAL '30 days')::int AS created_last_30_days,
        count(*) FILTER (WHERE role <> 'user' OR (
          EXISTS (SELECT 1 FROM user_consent WHERE user_id = user_account.user_id
            AND consent_type = 'terms_of_service_acceptance' AND granted AND withdrawn_at IS NULL AND document_version = $1)
          AND EXISTS (SELECT 1 FROM user_consent WHERE user_id = user_account.user_id
            AND consent_type = 'privacy_notice_acknowledgement' AND granted AND withdrawn_at IS NULL AND document_version = $2)
        ))::int AS onboarded
      FROM user_account WHERE deleted_at IS NULL
    `, [termsVersion, privacyVersion])).rows[0] ?? { total: 0, active: 0, banned: 0, onboarded: 0, created_last_30_days: 0 };
    const moderation = (await this.database.query<AdminMetrics['moderation']>(`
      SELECT (SELECT count(*)::int FROM user_report WHERE status = 'pending') AS pending_reports,
        (SELECT count(*)::int FROM data_subject_request WHERE status IN ('pending', 'in_progress')) AS open_data_requests
    `)).rows[0] ?? { pending_reports: 0, open_data_requests: 0 };
    const matchRows = (await this.database.query<{ status: keyof AdminMetrics['matches']; count: number }>(`
      SELECT status, count(*)::int AS count FROM match_init GROUP BY status
    `)).rows;
    const matches: AdminMetrics['matches'] = { active: 0, awaiting_continuation: 0, confirmed: 0, expired: 0, ended: 0 };
    for (const row of matchRows) matches[row.status] = row.count;
    const messages = (await this.database.query<{ total: number }>('SELECT count(*)::int AS total FROM chat_message')).rows[0] ?? { total: 0 };
    const subscriptions = (await this.database.query<{ plan: string; users: number }>(`
      SELECT plan.code AS plan,
        count(account.user_id) FILTER (WHERE COALESCE(subscription.plan, 'free') = plan.code)::int AS users
      FROM subscription_plan AS plan
      CROSS JOIN user_account AS account
      LEFT JOIN user_subscription AS subscription ON subscription.user_id = account.user_id
      WHERE account.deleted_at IS NULL
      GROUP BY plan.code ORDER BY plan.code
    `)).rows;
    return { users, moderation, matches, messages, subscriptions };
  }

  async messages(
    matchId: string,
    adminId: string,
    adminRole: AdminRole,
    reason: string,
    limit: number,
    offset: number,
    cursor: KeysetCursor | undefined,
  ): Promise<AdminMessageRow[] | undefined> {
    return this.database.transaction(async (client) => {
      const match = (await client.query<{ user1_id: string; user2_id: string }>(`
        SELECT user1_id, user2_id FROM match_init WHERE id = $1
      `, [matchId])).rows[0];
      if (!match) return undefined;
      await client.query(`
        INSERT INTO data_access_log (accessed_user_id, accessor_id, accessor_role, action, reason)
        VALUES ($1, $3, $4, 'view_messages', $5), ($2, $3, $4, 'view_messages', $5)
      `, [match.user1_id, match.user2_id, adminId, adminRole, reason]);
      return (await client.query<AdminMessageRow>(`
        SELECT id, match_id, sender_id, content, created_at, read_at,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
        FROM chat_message WHERE match_id = $1
          AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3
      `, [matchId, limit, offset, cursor?.at ?? null, cursor?.id ?? null])).rows;
    });
  }
}

function dateOnly(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}
