export const DATA_REQUEST_TYPES = ['access', 'erasure', 'portability', 'rectification', 'restriction', 'objection'] as const;
export type DataRequestType = typeof DATA_REQUEST_TYPES[number];

export const DATA_REQUEST_STATUSES = ['pending', 'in_progress', 'completed', 'rejected'] as const;
export type DataRequestStatus = typeof DATA_REQUEST_STATUSES[number];

export type DataSubjectRequestRow = {
  id: string;
  user_id: string;
  type: DataRequestType;
  status: DataRequestStatus;
  requested_at: Date;
  completed_at: Date | null;
  handled_by: string | null;
  notes?: string | null;
};

type DataAccessAction = 'view_profile' | 'view_messages' | 'view_matches' | 'export_data'
  | 'admin_ban' | 'admin_unban' | 'admin_review_report' | 'admin_review_dsr'
  | 'system_anonymize' | 'system_export_portability';

export type DataAccessLogRow = {
  id: string;
  accessed_user_id: string;
  accessor_id: string | null;
  accessor_role: string | null;
  action: DataAccessAction;
  reason: string | null;
  accessed_at: Date;
};

export type BlockedUser = {
  user_id: string;
  firstname: string | null;
  photo: string | null;
  blocked_at: Date;
};

export type PortableUserData = Record<string, unknown>;

export type PrivacyMaintenanceResult = {
  stale_presences: number;
  expired_presences: number;
  expired_otps: number;
  expired_refresh_tokens: number;
  expired_mobile_sessions: number;
  expired_notifications: number;
  expired_consents: number;
  expired_data_subject_requests: number;
  expired_data_access_logs: number;
  expired_reports: number;
  expired_account_tombstones: number;
  expired_account_deletion_tokens: number;
  expired_admin_webauthn_challenges: number;
  expired_admin_webauthn_bootstraps: number;
  expired_admin_sessions: number;
  expired_admin_auth_events: number;
  expired_outbox_operator_actions: number;
};
