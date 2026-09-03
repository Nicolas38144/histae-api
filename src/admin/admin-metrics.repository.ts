import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { AdminBusinessMetrics, AdminPhotoMetrics, AdminRevenue, RevenuePeriod } from './admin.models';

@Injectable()
export class AdminMetricsRepository {
  constructor(private readonly database: DatabaseService) {}

  async revenue(revenuePeriod: RevenuePeriod): Promise<AdminRevenue> {
    const row = (await this.database.query<{
      period_start: Date | null; period_end: Date; premium_subscriptions: number;
      price_per_subscription_cents: number; estimated_revenue_cents: string | number; currency: string;
    }>(`
      WITH anchor AS (
        SELECT clock_timestamp() AS now_utc, clock_timestamp() AT TIME ZONE 'Europe/Paris' AS paris_now
      ), bounds AS (
        SELECT
          CASE $1::text
            WHEN 'last_7_days' THEN now_utc - INTERVAL '7 days'
            WHEN 'last_30_days' THEN now_utc - INTERVAL '30 days'
            WHEN 'month_to_date' THEN date_trunc('month', paris_now) AT TIME ZONE 'Europe/Paris'
            WHEN 'previous_month' THEN date_trunc('month', paris_now - INTERVAL '1 month') AT TIME ZONE 'Europe/Paris'
            WHEN 'year_to_date' THEN date_trunc('year', paris_now) AT TIME ZONE 'Europe/Paris'
            WHEN 'all_time' THEN NULL
          END AS period_start,
          CASE $1::text
            WHEN 'previous_month' THEN date_trunc('month', paris_now) AT TIME ZONE 'Europe/Paris'
            ELSE now_utc
          END AS period_end
        FROM anchor
      )
      SELECT bounds.period_start, bounds.period_end,
        count(subscription.user_id)::int AS premium_subscriptions,
        COALESCE(max(plan.monthly_price_cents), 0)::int AS price_per_subscription_cents,
        (count(subscription.user_id) * COALESCE(max(plan.monthly_price_cents), 0))::bigint AS estimated_revenue_cents,
        COALESCE(max(plan.currency), 'EUR')::text AS currency
      FROM bounds
      LEFT JOIN subscription_plan AS plan ON plan.code = 'premium'
      LEFT JOIN user_subscription AS subscription ON subscription.plan = plan.code
        AND (bounds.period_start IS NULL OR subscription.updated_at >= bounds.period_start)
        AND subscription.updated_at < bounds.period_end
      GROUP BY bounds.period_start, bounds.period_end
    `, [revenuePeriod])).rows[0];
    return {
      period: revenuePeriod, period_start: row?.period_start ?? null, period_end: row?.period_end ?? new Date(),
      premium_subscriptions: Number(row?.premium_subscriptions ?? 0),
      price_per_subscription_cents: Number(row?.price_per_subscription_cents ?? 0),
      estimated_revenue_cents: Number(row?.estimated_revenue_cents ?? 0),
      currency: row?.currency ?? 'EUR', basis: 'premium_monthly_price',
    };
  }

  async metrics(
    termsVersion: string,
    privacyVersion: string,
    revenuePeriod: RevenuePeriod,
    photoStaleBefore: Date,
  ): Promise<AdminBusinessMetrics> {
    const users = (await this.database.query<AdminBusinessMetrics['users']>(`
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
    const moderation = (await this.database.query<AdminBusinessMetrics['moderation']>(`
      SELECT (SELECT count(*)::int FROM user_report WHERE status = 'pending') AS pending_reports,
        (SELECT count(*)::int FROM content_moderation_case WHERE status = 'pending') AS pending_content,
        (SELECT count(*)::int FROM data_subject_request WHERE status IN ('pending', 'in_progress')) AS open_data_requests
    `)).rows[0] ?? { pending_reports: 0, pending_content: 0, open_data_requests: 0 };
    const matchRows = (await this.database.query<{ status: keyof AdminBusinessMetrics['matches']; count: number }>(`
      SELECT status, count(*)::int AS count FROM match_init GROUP BY status
    `)).rows;
    const matches: AdminBusinessMetrics['matches'] = { active: 0, awaiting_continuation: 0, confirmed: 0, expired: 0, ended: 0 };
    for (const row of matchRows) matches[row.status] = row.count;
    const messages = (await this.database.query<{ total: number }>('SELECT count(*)::int AS total FROM chat_message')).rows[0] ?? { total: 0 };
    const photos = (await this.database.query<AdminPhotoMetrics>(`
      SELECT count(*) FILTER (WHERE photo.status = 'pending')::int AS pending,
        count(*) FILTER (WHERE photo.status = 'processing')::int AS processing,
        count(*) FILTER (WHERE photo.status = 'ready')::int AS ready,
        count(*) FILTER (WHERE photo.status = 'deleting')::int AS deleting,
        count(*) FILTER (WHERE photo.status IN ('pending', 'processing') AND photo.updated_at <= $1)::int AS stale_processing,
        count(*) FILTER (WHERE photo.status = 'deleting' AND event.status = 'dead_letter')::int AS deletion_dead_letters,
        count(*) FILTER (WHERE photo.status = 'deleting' AND (event.id IS NULL OR event.status = 'completed'))::int AS deletion_without_active_event
      FROM user_photo AS photo
      LEFT JOIN outbox_event AS event ON event.event_type = 'photo.delete' AND event.aggregate_id = photo.id
    `, [photoStaleBefore])).rows[0] ?? {
      pending: 0, processing: 0, ready: 0, deleting: 0,
      stale_processing: 0, deletion_dead_letters: 0, deletion_without_active_event: 0,
    };
    const subscriptions = (await this.database.query<{ plan: string; users: number }>(`
      WITH account_plans AS MATERIALIZED (
        SELECT COALESCE(subscription.plan, 'free') AS plan, count(*)::int AS users
        FROM user_account AS account
        LEFT JOIN user_subscription AS subscription ON subscription.user_id = account.user_id
        WHERE account.deleted_at IS NULL GROUP BY COALESCE(subscription.plan, 'free')
      )
      SELECT plan.code AS plan, COALESCE(account_plans.users, 0)::int AS users
      FROM subscription_plan AS plan
      LEFT JOIN account_plans ON account_plans.plan = plan.code ORDER BY plan.code
    `)).rows;
    return { users, moderation, matches, messages, photos, subscriptions, revenue: await this.revenue(revenuePeriod) };
  }
}
