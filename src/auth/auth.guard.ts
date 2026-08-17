import type { CanActivate, ExecutionContext} from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';
import { apiError } from '../common/api-error';
import { DatabaseService } from '../database/database.service';
import { ConfigService } from '../config/config.service';
import { ALLOW_INCOMPLETE_ONBOARDING_KEY } from './onboarding.decorator';
import type { AuthenticatedRequest, ActiveAccount } from './auth.types';

@Injectable()
export class JwtActiveGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly database: DatabaseService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const parts = (request.headers.authorization ?? '').trim().split(/\s+/);
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
      throw apiError(401, 'authentication_required', 'A valid Bearer Authorization header is required.');
    }
    let payload: { sub?: unknown };
    try {
      payload = await this.jwt.verifyAsync<{ sub?: unknown }>(parts[1], { algorithms: ['HS256'] });
    } catch {
      throw apiError(401, 'invalid_or_expired_access_token', 'The access token is invalid or expired.');
    }
    if (typeof payload.sub !== 'string' || !isUUID(payload.sub, 'all')) {
      throw apiError(401, 'invalid_or_expired_access_token', 'The access token is invalid or expired.');
    }
    const account = await this.activeAccount(payload.sub);
    request.auth = { userId: payload.sub, account };
    const allowIncompleteOnboarding = this.reflector.getAllAndOverride<boolean>(ALLOW_INCOMPLETE_ONBOARDING_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!allowIncompleteOnboarding && !account.onboarding_complete) {
      throw apiError(403, 'onboarding_incomplete', 'The current terms and privacy notice must be acknowledged before using this route.');
    }
    return true;
  }

  private async activeAccount(userId: string): Promise<ActiveAccount> {
    let account: ActiveAccount | undefined;
    try {
      const result = await this.database.query<ActiveAccount>(`
        SELECT account.user_id, account.role, account.is_banned,
          (
            account.role <> 'user'
            OR (
              EXISTS (
                SELECT 1 FROM user_consent
                WHERE user_id = account.user_id
                  AND consent_type = 'terms_of_service_acceptance'
                  AND granted = true AND withdrawn_at IS NULL AND document_version = $2
              )
              AND EXISTS (
                SELECT 1 FROM user_consent
                WHERE user_id = account.user_id
                  AND consent_type = 'privacy_notice_acknowledgement'
                  AND granted = true AND withdrawn_at IS NULL AND document_version = $3
              )
            )
          ) AS onboarding_complete
        FROM user_account AS account
        WHERE account.user_id = $1 AND account.deleted_at IS NULL
      `, [userId, this.config.legal.termsVersion, this.config.legal.privacyVersion]);
      account = result.rows[0];
    } catch (error) {
      throw apiError(500, 'account_check_failed', 'The account could not be verified.', error);
    }
    if (!account) throw apiError(401, 'authentication_required', 'A valid access token is required.');
    if (account.is_banned) throw apiError(403, 'account_unavailable', 'This account is unavailable.');
    return account;
  }
}

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.auth) throw apiError(401, 'authentication_required', 'A valid access token is required.');
    if (request.auth.account.role !== 'admin' && request.auth.account.role !== 'superadmin') {
      throw apiError(403, 'admin_required', 'Administrator access is required.');
    }
    return true;
  }
}

export function userId(request: AuthenticatedRequest): string {
  if (!request.auth) throw apiError(401, 'authentication_required', 'A valid access token is required.');
  return request.auth.userId;
}
