import { Controller, Delete, Get, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { userId } from '../auth/auth.guard';
import { ValidatedBody, ValidatedParams } from '../common/http/validated-request.decorator';
import { ConfigService } from '../config/config.service';
import { RateLimitService } from '../ratelimit/rate-limit.service';
import { AdminSessionGuard, RecentAdminAuthenticationGuard } from './admin-auth.guard';
import type { AdminAuthSession, AdminCredential, AuthenticationOptions, RegistrationOptions } from './admin-auth.models';
import { AdminAuthService } from './admin-auth.service';
import { adminSessionCookie, expiredAdminSessionCookie } from './admin-session-cookie';
import {
  AdditionalCredentialVerifyDto,
  AdminCredentialIdParamDto,
  AuthenticationVerifyDto,
  BootstrapRegistrationOptionsDto,
  BootstrapRegistrationVerifyDto,
} from './dto/admin-auth.dto';

const AUTH_ERROR = { code: 'invalid_admin_auth_request', message: 'The administrator authentication request is invalid.' };

@Controller('api/admin/auth')
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly limits: RateLimitService,
    private readonly config: ConfigService,
  ) {}

  @Post('login/options')
  @HttpCode(HttpStatus.OK)
  async loginOptions(@Req() request: FastifyRequest): Promise<AuthenticationOptions> {
    await this.limit(request);
    return this.auth.authenticationOptions();
  }

  @Post('login/verify')
  @HttpCode(HttpStatus.OK)
  async loginVerify(
    @ValidatedBody(AUTH_ERROR) body: AuthenticationVerifyDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AdminAuthSession> {
    await this.limit(request);
    const created = await this.auth.authenticate({ challengeId: body.challenge_id, credential: body.credential });
    reply.header('Set-Cookie', adminSessionCookie(created.token, this.config.adminAuth));
    return created.session;
  }

  @Post('bootstrap/options')
  @HttpCode(HttpStatus.OK)
  async bootstrapOptions(
    @ValidatedBody(AUTH_ERROR) body: BootstrapRegistrationOptionsDto,
    @Req() request: FastifyRequest,
  ): Promise<RegistrationOptions> {
    await this.limit(request);
    return this.auth.bootstrapRegistrationOptions(body.bootstrap_token);
  }

  @Post('bootstrap/verify')
  async bootstrapVerify(
    @ValidatedBody(AUTH_ERROR) body: BootstrapRegistrationVerifyDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AdminAuthSession> {
    await this.limit(request);
    const created = await this.auth.completeBootstrapRegistration({
      token: body.bootstrap_token,
      challengeId: body.challenge_id,
      credential: body.credential,
      name: body.name,
    });
    reply.header('Set-Cookie', adminSessionCookie(created.token, this.config.adminAuth));
    return created.session;
  }

  @Get('session')
  @UseGuards(AdminSessionGuard)
  session(@Req() request: AuthenticatedRequest): AdminAuthSession {
    const session = adminSession(request);
    return {
      user_id: userId(request),
      role: request.auth!.account.role as 'admin' | 'superadmin',
      authenticated_at: session.authenticatedAt.toISOString(),
      expires_at: session.expiresAt.toISOString(),
    };
  }

  @Post('logout')
  @UseGuards(AdminSessionGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    await this.auth.revokeSession(userId(request), adminSession(request).id);
    reply.header('Set-Cookie', expiredAdminSessionCookie(this.config.adminAuth));
  }

  @Get('credentials')
  @UseGuards(AdminSessionGuard)
  credentials(@Req() request: AuthenticatedRequest): Promise<AdminCredential[]> {
    return this.auth.credentials(userId(request), adminSession(request).credentialId);
  }

  @Post('credentials/options')
  @UseGuards(AdminSessionGuard, RecentAdminAuthenticationGuard)
  credentialOptions(@Req() request: AuthenticatedRequest): Promise<RegistrationOptions> {
    return this.auth.additionalRegistrationOptions(userId(request));
  }

  @Post('credentials/verify')
  @UseGuards(AdminSessionGuard, RecentAdminAuthenticationGuard)
  @HttpCode(HttpStatus.CREATED)
  async credentialVerify(
    @ValidatedBody(AUTH_ERROR) body: AdditionalCredentialVerifyDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ message: string }> {
    await this.auth.addCredential({
      userId: userId(request),
      challengeId: body.challenge_id,
      credential: body.credential,
      name: body.name,
    });
    return { message: 'administrator credential registered' };
  }

  @Delete('credentials/:id')
  @UseGuards(AdminSessionGuard, RecentAdminAuthenticationGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeCredential(
    @ValidatedParams({ code: 'invalid_admin_credential_id', message: 'The administrator credential ID is invalid.' }) params: AdminCredentialIdParamDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    const session = adminSession(request);
    await this.auth.revokeCredential(userId(request), params.id, session.id, session.credentialId);
  }

  @Post('sessions/revoke-others')
  @UseGuards(AdminSessionGuard, RecentAdminAuthenticationGuard)
  async revokeOtherSessions(@Req() request: AuthenticatedRequest): Promise<{ revoked_sessions: number }> {
    return { revoked_sessions: await this.auth.revokeOtherSessions(userId(request), adminSession(request).id) };
  }

  private async limit(request: FastifyRequest): Promise<void> {
    await this.limits.enforce(
      'admin-auth',
      request.ip,
      this.config.rateLimit.adminAuth,
      'admin_auth_rate_limit_exceeded',
    );
  }
}

function adminSession(request: AuthenticatedRequest) {
  const session = request.auth?.adminSession;
  if (!session) throw new Error('AdminSessionGuard did not attach a session');
  return session;
}
