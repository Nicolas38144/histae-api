export type Account = { user_id: string; role: 'user' | 'admin' | 'superadmin'; is_banned: boolean };

export type StoredRefreshToken = {
  id: string;
  user_id: string;
  token_hash: string;
  jti: string;
  revoked: boolean;
  expires_at: Date;
  family_id: string;
  rotated_at: Date | null;
};

export type MobileSessionIdentity = { userId: string; sessionId: string };
export type MobileSessionRow = {
  id: string;
  created_at: Date;
  last_refreshed_at: Date;
  expires_at: Date;
  cursor_at: string;
};

export type NewRefreshToken = {
  id: string;
  jti: string;
  plain: string;
  hash: string;
  createdAt: Date;
  expiresAt: Date;
};

export type TokenPair = { access_token: string; refresh_token: string };
