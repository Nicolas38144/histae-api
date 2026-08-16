import { Injectable } from '@nestjs/common';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { apiError } from '../common/api-error';
import { ConfigService } from '../config/config.service';
import { encryptPhone, hmacSha256 } from '../crypto/phone-crypto';
import { AuthRepository } from './auth.repository';
import { AccountTombstoneError } from './auth.repository';
import type { Account, TokenPair } from './auth.models';
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

  async sendOtp(phoneInput: string): Promise<{ message: string }> {
    this.otp.validatePhoneForDelivery(phoneInput);
    // Intentionally unavailable until a real delivery provider persists and sends OTPs atomically.
    throw apiError(503, 'otp_delivery_unavailable', 'SMS code delivery is not configured.');
  }

  async verifyOtp(phoneInput: string, otp: string): Promise<TokenPair> {
    const verified = await this.otp.consume(phoneInput, otp);
    let account = await this.authRepository.findAccountByPhoneHash(verified.phoneHash);
    if (!account) {
      try {
        account = await this.authRepository.createAccount({
          userId: randomUUID(),
          role: 'user',
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

  async register(phoneInput: string): Promise<{ user_id: string; access_token: string; refresh_token: string }> {
    if (this.config.env !== 'development') throw apiError(404, 'route_not_found', 'This route is not available.');
    const phone = this.otp.normalizePhone(phoneInput, 'invalid_registration_request', 'The account creation request is invalid.');
    const phoneHash = hmacSha256(phone, this.config.phone.hashKey);
    let account: Account;
    try {
      account = await this.authRepository.createAccount({
        userId: randomUUID(),
        role: 'user',
        phoneHash,
        encryptedPhone: encryptPhone(phone, this.config.phone.encryptionKey),
      });
    } catch (error) {
      if (error instanceof AccountTombstoneError) throw apiError(403, 'account_unavailable', 'This account is unavailable.', error);
      if (isPgUniqueViolation(error)) throw apiError(409, 'account_already_exists', 'An account already exists for this phone number.', error);
      throw error;
    }
    return { user_id: account.user_id, ...await this.issueTokenPair(account.user_id) };
  }

  async bootstrapSuperadmin(phoneInput: string, suppliedSecret: string | undefined): Promise<{ user_id: string; access_token: string; refresh_token: string }> {
    if (this.config.env !== 'development') throw apiError(404, 'route_not_found', 'This route is not available.');
    if (!this.config.devBootstrapSecret) {
      throw apiError(503, 'dev_bootstrap_unavailable', 'The development bootstrap secret is not configured.');
    }
    if (!secretsMatch(this.config.devBootstrapSecret, suppliedSecret)) {
      throw apiError(403, 'dev_bootstrap_forbidden', 'The development bootstrap secret is invalid.');
    }
    const phone = this.otp.normalizePhone(phoneInput, 'invalid_bootstrap_request', 'The bootstrap request is invalid.');
    const phoneHash = hmacSha256(phone, this.config.phone.hashKey);
    let account: Account | undefined;
    try {
      account = await this.authRepository.createDevelopmentSuperadmin({
        userId: randomUUID(),
        phoneHash,
        encryptedPhone: encryptPhone(phone, this.config.phone.encryptionKey),
      });
    } catch (error) {
      if (isPgUniqueViolation(error)) throw apiError(409, 'account_already_exists', 'An account already exists for this phone number.', error);
      throw error;
    }
    if (!account) throw apiError(409, 'superadmin_already_exists', 'A development superadmin already exists.');
    return { user_id: account.user_id, ...await this.issueTokenPair(account.user_id) };
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

function secretsMatch(expected: string, supplied: string | undefined): boolean {
  if (!supplied) return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}
