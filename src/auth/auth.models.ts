export type Account = { user_id: string; role: 'user' | 'admin' | 'superadmin'; is_banned: boolean };

export type StoredRefreshToken = {
  id: string;
  user_id: string;
  token_hash: string;
  jti: string;
  revoked: boolean;
  expires_at: Date;
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
