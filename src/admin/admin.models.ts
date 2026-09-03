import type { MatchStatus, MessageRow } from '../matches/matches.models';
import type { ConsentType, LookingFor, Sex } from '../users/users.models';

export const ADMIN_USER_STATUSES = ['active', 'banned'] as const;
export type AdminUserStatus = typeof ADMIN_USER_STATUSES[number];

export const REVENUE_PERIODS = [
  'last_7_days',
  'last_30_days',
  'month_to_date',
  'previous_month',
  'year_to_date',
  'all_time',
] as const;
export type RevenuePeriod = typeof REVENUE_PERIODS[number];

export const PHOTO_RECONCILIATION_FILTERS = [
  'all',
  'stale_processing',
  'deleting',
  'dead_letter',
] as const;
export type PhotoReconciliationFilter = typeof PHOTO_RECONCILIATION_FILTERS[number];

export type AdminPhotoMetrics = {
  pending: number;
  processing: number;
  ready: number;
  deleting: number;
  stale_processing: number;
  deletion_dead_letters: number;
  deletion_without_active_event: number;
};

export type PhotoReconciliationIssue =
  | 'stale_processing'
  | 'deletion_queued'
  | 'deletion_processing'
  | 'deletion_retry_scheduled'
  | 'deletion_dead_letter'
  | 'deletion_event_missing'
  | 'deletion_event_completed';

export type AdminPhotoReconciliationRow = {
  id: string;
  user_id: string;
  status: 'pending' | 'processing' | 'deleting';
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  created_at: Date;
  updated_at: Date;
  outbox_status: 'pending' | 'processing' | 'completed' | 'dead_letter' | null;
  outbox_attempts: number | null;
  outbox_available_at: Date | null;
  outbox_locked_at: Date | null;
  outbox_last_error_code: string | null;
  issue: PhotoReconciliationIssue;
  cursor_at: string;
};

export type AdminPhotoReconciliation = Omit<AdminPhotoReconciliationRow, 'id' | 'cursor_at'> & {
  photo_id: string;
};

export type PhotoReconciliationResult =
  | 'queued'
  | 'not_found'
  | 'not_actionable'
  | 'already_processing';

export type AdminRevenue = {
  period: RevenuePeriod;
  period_start: Date | null;
  period_end: Date;
  premium_subscriptions: number;
  price_per_subscription_cents: number;
  estimated_revenue_cents: number;
  currency: string;
  basis: 'premium_monthly_price';
};

export type AdminUserRow = {
  id: string;
  role: 'user' | 'admin' | 'superadmin';
  is_banned: boolean;
  banned_at: Date | null;
  created_at: Date;
  firstname: string | null;
  birthdate: Date | string | null;
  sex: Sex | null;
  photo: string | null;
  plan: string;
  onboarding_complete: boolean;
  reports_received: number;
  matches_count: number;
  cursor_at: string;
};

export type AdminUser = Omit<AdminUserRow, 'id' | 'cursor_at' | 'birthdate'> & {
  user_id: string;
  birthdate: string | null;
};

export type AdminUserDetail = AdminUser & {
  banned_reason: string | null;
  preferences: {
    min_age: number;
    max_age: number;
    max_distance_km: number;
    looking_for: LookingFor;
  } | null;
  traits: Array<{ id: string; name: string }>;
  consents: Array<{
    consent_type: ConsentType;
    granted: boolean;
    document_version: string;
    updated_at: Date;
  }>;
  presence: { is_location_fresh: boolean; updated_at: Date } | null;
};

export type AdminMetrics = {
  users: { total: number; active: number; banned: number; onboarded: number; created_last_30_days: number };
  moderation: { pending_reports: number; pending_content: number; open_data_requests: number };
  matches: Record<MatchStatus, number>;
  messages: { total: number };
  photos: AdminPhotoMetrics;
  subscriptions: Array<{ plan: string; users: number }>;
  revenue: AdminRevenue;
};

export type AdminMessageRow = MessageRow & { cursor_at: string };
