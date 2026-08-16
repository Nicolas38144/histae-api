import { Controller, Headers, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ApiAcceptedResponse, ApiCreatedResponse, ApiExcludeEndpoint, ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ValidatedBody } from '../common/http/validated-request.decorator';
import { MessageResponseDto, RegistrationResponseDto, TokenPairResponseDto } from '../common/dto/responses.dto';
import { ConfigService } from '../config/config.service';
import { RateLimitService } from '../ratelimit/rate-limit.service';
import { DevelopmentOnlyGuard, JwtActiveGuard, userId } from './auth.guard';
import type { AuthenticatedRequest } from './auth.types';
import { AuthService } from './auth.service';
import { BootstrapSuperadminDto, RefreshTokenDto, RegisterDto, SendOtpDto, VerifyOtpDto } from './dto/auth.dto';
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

  @Post('otp/send')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ type: MessageResponseDto })
  async sendOtp(
    @ValidatedBody() body: SendOtpDto,
    @Req() request: FastifyRequest,
  ): Promise<{ message: string }> {
    const phoneKey = this.otp.rateLimitKey(body.phone_number, 'invalid_phone_number', 'The phone number must use the international E.164 format.');
    await this.limits.enforce('otp-send-ip', request.ip, this.config.rateLimit.otp, 'otp_rate_limit_exceeded');
    await this.limits.enforce('otp-send-phone', phoneKey, this.config.rateLimit.otp, 'otp_rate_limit_exceeded');
    return this.auth.sendOtp(body.phone_number);
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
  async logout(@ValidatedBody() body: RefreshTokenDto, @Req() request: AuthenticatedRequest): Promise<void> {
    await this.auth.logout(userId(request), body.refresh_token);
  }

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiCreatedResponse({ type: RegistrationResponseDto })
  async register(
    @ValidatedBody() body: RegisterDto,
    @Req() request: FastifyRequest,
  ): Promise<{ user_id: string; access_token: string; refresh_token: string }> {
    const phoneKey = this.otp.rateLimitKey(body.phone_number, 'invalid_registration_request', 'The account creation request is invalid.');
    await this.limits.enforce('registration-ip', request.ip, this.config.rateLimit.registration, 'registration_rate_limit_exceeded');
    await this.limits.enforce('registration-phone', phoneKey, this.config.rateLimit.registration, 'registration_rate_limit_exceeded');
    return this.auth.register(body.phone_number);
  }

  @Post('dev/bootstrap-superadmin')
  @UseGuards(DevelopmentOnlyGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiExcludeEndpoint()
  async bootstrapSuperadmin(
    @ValidatedBody({ code: 'invalid_bootstrap_request', message: 'The bootstrap request is invalid.' }) body: BootstrapSuperadminDto,
    @Headers('x-dev-bootstrap-secret') secret: string | undefined,
  ): Promise<{ user_id: string; access_token: string; refresh_token: string }> {
    return this.auth.bootstrapSuperadmin(body.phone_number, secret);
  }
}
