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
