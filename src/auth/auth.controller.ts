import { Controller, Get, Headers, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ApiAcceptedResponse, ApiHeader, ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ValidatedBody } from '../common/http/validated-request.decorator';
import { MessageResponseDto, SessionResponseDto, TokenPairResponseDto } from '../common/dto/responses.dto';
import { ConfigService } from '../config/config.service';
import { RateLimitService } from '../ratelimit/rate-limit.service';
import { JwtActiveGuard, userId } from './auth.guard';
import type { AuthenticatedRequest } from './auth.types';
import { AuthService } from './auth.service';
import { LogoutDto, RefreshTokenDto, SendOtpDto, VerifyOtpDto } from './dto/auth.dto';
import { AllowIncompleteOnboarding } from './onboarding.decorator';
import { OtpService } from './otp.service';

@Controller('api/auth')
@ApiTags('Authentication')
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
  @ApiOkResponse({ type: SessionResponseDto })
  me(@Req() request: AuthenticatedRequest): { user_id: string; onboarding_complete: boolean } {
    return {
      user_id: userId(request),
      onboarding_complete: request.auth!.account.onboarding_complete,
    };
  }

  @Post('otp/send')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'A new UUID v4 for the logical send request.' })
  @ApiAcceptedResponse({ type: MessageResponseDto })
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
  @ApiOkResponse({ type: TokenPairResponseDto })
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
  @ApiOkResponse({ type: TokenPairResponseDto })
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
  @ApiNoContentResponse()
  async logout(@ValidatedBody() body: LogoutDto, @Req() request: AuthenticatedRequest): Promise<void> {
    await this.auth.logout(userId(request), body.refresh_token, body.device_id);
  }
}
