import { Controller, Delete, Get, Headers, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ValidatedBody, ValidatedParams, ValidatedQuery } from '../common/http/validated-request.decorator';
import { ConfigService } from '../config/config.service';
import { RateLimitService } from '../ratelimit/rate-limit.service';
import { JwtActiveGuard, mobileSession, userId } from './auth.guard';
import type { AuthenticatedRequest } from './auth.types';
import { AuthService } from './auth.service';
import { LogoutAllDto, LogoutDto, MobileSessionIdDto, MobileSessionQueryDto, RefreshTokenDto, SendOtpDto, VerifyOtpDto } from './dto/auth.dto';
import { AllowIncompleteOnboarding } from './onboarding.decorator';
import { OtpService } from './otp.service';

@Controller('api/auth')

export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly limits: RateLimitService,
    private readonly config: ConfigService,
    private readonly otp: OtpService,
  ) {}

  @Get('me')
  @UseGuards(JwtActiveGuard)
  @AllowIncompleteOnboarding()

  me(@Req() request: AuthenticatedRequest): { user_id: string; onboarding_complete: boolean } {
    return {
      user_id: userId(request),
      onboarding_complete: request.auth!.account.onboarding_complete,
    };
  }

  @Post('otp/send')
  @HttpCode(HttpStatus.ACCEPTED)

  async sendOtp(
    @ValidatedBody() body: SendOtpDto,
    @Req() request: FastifyRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<{ message: string }> {
    const phoneKey = this.otp.rateLimitKey(body.phone_number, 'invalid_phone_number', 'The phone number must be a French number in E.164 format (+33).');
    await this.limits.enforce('otp-send-ip', request.ip, this.config.rateLimit.otp, 'otp_rate_limit_exceeded');
    await this.limits.enforce('otp-send-phone', phoneKey, this.config.rateLimit.otp, 'otp_rate_limit_exceeded');
    return this.auth.sendOtp(body.phone_number, idempotencyKey);
  }

  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)

  async verifyOtp(
    @ValidatedBody() body: VerifyOtpDto,
    @Req() request: FastifyRequest,
  ): Promise<{ access_token: string; refresh_token: string }> {
    const phoneKey = this.otp.rateLimitKey(body.phone_number, 'invalid_otp_request', 'The phone number or verification code is invalid.');
    await this.limits.enforce('otp-verify-ip', request.ip, this.config.rateLimit.otp, 'otp_rate_limit_exceeded');
    await this.limits.enforce('otp-verify-phone', phoneKey, this.config.rateLimit.otp, 'otp_rate_limit_exceeded');
    return this.auth.verifyOtp(body.phone_number, body.otp);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)

  async refresh(
    @ValidatedBody() body: RefreshTokenDto,
    @Req() request: FastifyRequest,
  ): Promise<{ access_token: string; refresh_token: string }> {
    await this.limits.enforce('refresh', request.ip, this.config.rateLimit.refresh, 'refresh_rate_limit_exceeded');
    return this.auth.refresh(body.refresh_token);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtActiveGuard)
  @AllowIncompleteOnboarding()

  async logout(@ValidatedBody() body: LogoutDto, @Req() request: AuthenticatedRequest): Promise<void> {
    await this.sessionRateLimit(request);
    await this.auth.logout(userId(request), mobileSession(request).id, body.refresh_token, body.device_id);
  }

  @Get('sessions')
  @UseGuards(JwtActiveGuard)
  @AllowIncompleteOnboarding()
  async sessions(@ValidatedQuery({ code: 'invalid_session_query', message: 'The session query is invalid.' }) query: MobileSessionQueryDto, @Req() request: AuthenticatedRequest) {
    await this.sessionRateLimit(request);
    return this.auth.listSessions(userId(request), mobileSession(request).id, query.limit, query.cursor);
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtActiveGuard)
  @AllowIncompleteOnboarding()
  async revokeSession(@ValidatedParams({ code: 'invalid_session_id', message: 'The session ID must be a UUID v4.' }) params: MobileSessionIdDto, @Req() request: AuthenticatedRequest): Promise<void> {
    await this.sessionRateLimit(request);
    await this.auth.revokeSession(userId(request), mobileSession(request).id, params.id);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtActiveGuard)
  @AllowIncompleteOnboarding()
  async logoutAll(@ValidatedBody() _body: LogoutAllDto, @Req() request: AuthenticatedRequest): Promise<{ revoked_sessions: number }> {
    await this.sessionRateLimit(request);
    return this.auth.logoutAll(userId(request), mobileSession(request).id);
  }

  private sessionRateLimit(request: AuthenticatedRequest): Promise<void> {
    return this.limits.enforce('mobile-sessions', userId(request), this.config.rateLimit.refresh, 'session_rate_limit_exceeded');
  }
}
