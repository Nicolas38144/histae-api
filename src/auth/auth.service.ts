import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { apiError } from '../common/api-error';
import { cursorPage, decodeCursor } from '../common/pagination';
import { ConfigService } from '../config/config.service';
import { encryptPhone } from '../crypto/phone-crypto';
import { AuthRepository } from './auth.repository';
import { AccountTombstoneError } from './auth.repository';
import type { TokenPair } from './auth.models';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';
import { RefreshSessionRepository } from './refresh-session.repository';

@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly authRepository: AuthRepository,
    private readonly otp: OtpService,
    private readonly tokens: TokenService,
    private readonly sessions: RefreshSessionRepository,
  ) {}

  async sendOtp(phoneInput: string, idempotencyKey: string | undefined): Promise<{ message: string }> {
    return this.otp.send(phoneInput, idempotencyKey);
  }

  async verifyOtp(phoneInput: string, otp: string): Promise<TokenPair> {
    const verified = await this.otp.consume(phoneInput, otp);
    let account = await this.authRepository.findAccountByPhoneHash(verified.phoneHash);
    if (!account) {
      try {
        account = await this.authRepository.createAccount({
          userId: randomUUID(),
          phoneHash: verified.phoneHash,
          encryptedPhone: encryptPhone(verified.phone, this.config.phone.encryptionKey),
        });
      } catch (error) {
        if (error instanceof AccountTombstoneError) throw apiError(403, 'account_unavailable', 'This account is unavailable.', error);
        if (isPgUniqueViolation(error)) {
          throw apiError(409, 'account_creation_conflict', 'Account creation conflicts with an ongoing operation. Please try again.', error);
        }
        throw error;
      }
    }
    if (account.is_banned) throw apiError(403, 'account_unavailable', 'This account is unavailable.');
    return this.issueTokenPair(account.user_id);
  }

  async refresh(rawToken: string): Promise<TokenPair> {
    const parsed = this.tokens.parseRefreshToken(rawToken);
    if (!parsed) throw invalidRefresh();
    const next = this.tokens.newRefreshToken();
    const session = await this.sessions.rotate(parsed.jti, parsed.hash, next);
    if (!session) throw invalidRefresh();
    return { access_token: await this.tokens.accessToken(session.userId, session.sessionId), refresh_token: next.plain };
  }

  async logout(ownerId: string, sessionId: string, rawToken: string, deviceId?: string): Promise<void> {
    const parsed = this.tokens.parseRefreshToken(rawToken);
    if (!parsed || !await this.sessions.logout(ownerId, sessionId, parsed.jti, parsed.hash, deviceId)) throw invalidRefresh();
  }

  async listSessions(userId: string, currentSessionId: string, limit: number, cursor?: string) {
    const page = cursorPage(await this.sessions.list(userId, limit + 1, decodeCursor(cursor)), limit, (row) => row.cursor_at);
    return {
      sessions: page.items.map(({ id, created_at, last_refreshed_at, expires_at }) => ({
        id, created_at, last_refreshed_at, expires_at, current: id === currentSessionId,
      })),
      next_cursor: page.next_cursor,
    };
  }

  async revokeSession(userId: string, currentSessionId: string, targetId: string): Promise<void> {
    const result = await this.sessions.revoke(userId, currentSessionId, targetId);
    if (result === undefined) throw invalidRefresh();
    if (result === 0) throw apiError(404, 'session_not_found', 'The mobile session could not be found.');
  }

  async logoutAll(userId: string, currentSessionId: string): Promise<{ revoked_sessions: number }> {
    const result = await this.sessions.revoke(userId, currentSessionId);
    if (result === undefined) throw invalidRefresh();
    return { revoked_sessions: result };
  }

  private async issueTokenPair(userId: string): Promise<TokenPair> {
    const refresh = this.tokens.newRefreshToken();
    const session = await this.sessions.create(userId, refresh);
    if (!session) throw apiError(403, 'account_unavailable', 'This account is unavailable.');
    return { access_token: await this.tokens.accessToken(userId, session.sessionId), refresh_token: refresh.plain };
  }
}

function invalidRefresh(): ReturnType<typeof apiError> {
  return apiError(401, 'invalid_or_expired_refresh_token', 'The refresh token is invalid, expired, or already used.');
}

function isPgUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
