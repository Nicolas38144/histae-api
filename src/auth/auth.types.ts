import type { FastifyRequest } from 'fastify';

export type ActiveAccount = {
  user_id: string;
  role: 'user' | 'admin' | 'superadmin';
  is_banned: boolean;
  onboarding_complete: boolean;
};

export type AuthenticatedRequest = FastifyRequest & {
  auth?: {
    userId: string;
    account: ActiveAccount;
    adminSession?: {
      id: string;
      credentialId: string;
      authenticatedAt: Date;
      expiresAt: Date;
    };
  };
};
