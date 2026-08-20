import type { MatchStatus, MessageRow } from '../matches/matches.models';
import type { ConsentType, LookingFor, Sex } from '../users/users.models';

export const ADMIN_USER_STATUSES = ['active', 'banned'] as const;
export type AdminUserStatus = typeof ADMIN_USER_STATUSES[number];

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
  moderation: { pending_reports: number; open_data_requests: number };
  matches: Record<MatchStatus, number>;
  messages: { total: number };
  subscriptions: Array<{ plan: string; users: number }>;
};

export type AdminMessageRow = MessageRow & { cursor_at: string };

