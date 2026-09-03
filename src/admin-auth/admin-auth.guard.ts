import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { apiError } from '../common/api-error';
import { ConfigService } from '../config/config.service';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { expiredAdminSessionCookie, readAdminSessionCookie } from './admin-session-cookie';
import { AdminAuthService } from './admin-auth.service';

@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    this.verifyMutationOrigin(request);
    const token = readAdminSessionCookie(request.headers.cookie, this.config.adminAuth.cookieName);
    const session = token ? await this.auth.authenticateSession(token) : undefined;
    if (!session) {
      reply.header('Set-Cookie', expiredAdminSessionCookie(this.config.adminAuth));
      throw apiError(401, 'admin_session_invalid', 'The administrator session is invalid or expired.');
    }
    request.auth = {
      userId: session.user_id,
      account: {
        user_id: session.user_id,
        role: session.role,
        is_banned: false,
        onboarding_complete: true,
      },
      adminSession: {
        id: session.id,
        credentialId: session.credential_id,
        authenticatedAt: session.authenticated_at,
        expiresAt: session.expires_at,
      },
    };
    return true;
  }

  private verifyMutationOrigin(request: AuthenticatedRequest): void {
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
    if (request.headers.origin !== this.config.adminAuth.origin) {
      throw apiError(403, 'invalid_admin_request_origin', 'The administrator request origin is not allowed.');
    }
  }
}

@Injectable()
export class RecentAdminAuthenticationGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authenticatedAt = request.auth?.adminSession?.authenticatedAt;
    if (!authenticatedAt
      || Date.now() - authenticatedAt.getTime() > this.config.adminAuth.recentAuthenticationMillis) {
      throw apiError(401, 'admin_reauthentication_required', 'A recent WebAuthn authentication is required.');
    }
    return true;
  }
}
