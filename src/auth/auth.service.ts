import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { apiError } from '../common/api-error';
import { ConfigService } from '../config/config.service';
import { encryptPhone } from '../crypto/phone-crypto';
import { AuthRepository } from './auth.repository';
import { AccountTombstoneError } from './auth.repository';
import type { TokenPair } from './auth.models';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly authRepository: AuthRepository,
    private readonly otp: OtpService,
    private readonly tokens: TokenService,
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
    const current = await this.authRepository.findRefreshToken(parsed.jti);
    if (!current || !this.tokens.isUsable(current, parsed.hash)) throw invalidRefresh();
    const account = await this.authRepository.findAccountById(current.user_id);
    if (!account || account.is_banned) throw invalidRefresh();

    const next = this.tokens.newRefreshToken();
    const userId = await this.authRepository.rotateRefreshToken(parsed.jti, parsed.hash, next);
    if (!userId) throw invalidRefresh();
    return { access_token: await this.tokens.accessToken(userId), refresh_token: next.plain };
  }

  async logout(ownerId: string, rawToken: string): Promise<void> {
    const parsed = this.tokens.parseRefreshToken(rawToken);
    if (!parsed || !await this.authRepository.revokeRefreshToken(ownerId, parsed.jti, parsed.hash)) throw invalidRefresh();
  }

  private async issueTokenPair(userId: string): Promise<TokenPair> {
    const refresh = this.tokens.newRefreshToken();
    await this.authRepository.insertRefreshToken(userId, refresh);
    return { access_token: await this.tokens.accessToken(userId), refresh_token: refresh.plain };
  }
}

function invalidRefresh(): ReturnType<typeof apiError> {
  return apiError(401, 'invalid_or_expired_refresh_token', 'The refresh token is invalid, expired, or already used.');
}

function isPgUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
