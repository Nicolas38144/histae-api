import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';

export type AdminRole = 'admin' | 'superadmin';

export type AdminAuthSession = {
  user_id: string;
  role: AdminRole;
  authenticated_at: string;
  expires_at: string;
};

export type AdminCredential = {
  id: string;
  name: string;
  device_type: 'singleDevice' | 'multiDevice';
  backed_up: boolean;
  transports: string[];
  created_at: string;
  last_used_at: string | null;
  current: boolean;
};

export type AdminSessionSummary = {
  id: string;
  credential_id: string;
  credential_name: string;
  authenticated_at: string;
  last_seen_at: string;
  expires_at: string;
  current: boolean;
};

export const ADMIN_AUTH_EVENT_TYPES = [
  'bootstrap_issued',
  'bootstrap_registered',
  'login_succeeded',
  'credential_added',
  'credential_renamed',
  'credential_revoked',
  'session_revoked',
  'other_sessions_revoked',
  'logout',
] as const;
export type AdminAuthEventType = typeof ADMIN_AUTH_EVENT_TYPES[number];

export type AdminAuthEvent = {
  id: string;
  event_type: AdminAuthEventType;
  credential_id: string | null;
  session_id: string | null;
  created_at: string;
};

export type RegistrationOptions = {
  challenge_id: string;
  options: PublicKeyCredentialCreationOptionsJSON;
};

export type AuthenticationOptions = {
  challenge_id: string;
  options: PublicKeyCredentialRequestOptionsJSON;
};

export type SessionCreation = {
  token: string;
  session: AdminAuthSession;
};
