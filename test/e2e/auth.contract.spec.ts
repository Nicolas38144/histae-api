import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { JwtService } from '@nestjs/jwt';
import { AuthController } from '../../src/auth/auth.controller';
import { JwtActiveGuard } from '../../src/auth/auth.guard';
import { AuthService } from '../../src/auth/auth.service';
import { ApiExceptionFilter } from '../../src/common/api-exception.filter';
import { ConfigService } from '../../src/config/config.service';
import { DatabaseService } from '../../src/database/database.service';
import { RateLimitService } from '../../src/ratelimit/rate-limit.service';
import { OtpService } from '../../src/auth/otp.service';
import type { AuthenticatedRequest } from '../../src/auth/auth.types';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';

describe('Auth HTTP contract', () => {
  let app: NestFastifyApplication;
  const auth = {
    sendOtp: jest.fn().mockResolvedValue({ message: 'Verification code request accepted.' }),
    verifyOtp: jest.fn().mockResolvedValue({ access_token: 'access-token', refresh_token: 'refresh-token' }),
    refresh: jest.fn().mockResolvedValue({ access_token: 'next-access', refresh_token: 'next-refresh' }),
    logout: jest.fn().mockResolvedValue(undefined),
  };
  const limits = { enforce: jest.fn().mockResolvedValue(undefined) };
  const activeGuard: CanActivate = {
    canActivate(context: ExecutionContext): boolean {
      const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
      request.auth = {
        userId: USER_ID,
        account: { user_id: USER_ID, role: 'user', is_banned: false, onboarding_complete: true },
      };
      return true;
    },
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: RateLimitService, useValue: limits },
        { provide: ConfigService, useValue: { env: 'development', rateLimit: { otp: { max: 5, windowMs: 3_600_000 }, refresh: { max: 30, windowMs: 900_000 } } } },
        { provide: OtpService, useValue: { rateLimitKey: jest.fn().mockReturnValue('phone-key') } },
        { provide: JwtService, useValue: {} },
        { provide: DatabaseService, useValue: {} },
      ],
    }).overrideGuard(JwtActiveGuard).useValue(activeGuard).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
  });

  afterAll(async () => app?.close());

  beforeEach(() => jest.clearAllMocks());

  it('returns the authenticated mobile session bootstrap', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/api/auth/me' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user_id: USER_ID, onboarding_complete: true });
  });

  it('accepts an idempotent OTP send request and forwards its UUID', async () => {
    const idempotencyKey = 'f5c3c744-a75f-46e7-8b59-6b94671cb029';
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/api/auth/otp/send',
      headers: { 'idempotency-key': idempotencyKey },
      payload: { phone_number: '+33612345678' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ message: 'Verification code request accepted.' });
    expect(auth.sendOtp).toHaveBeenCalledWith('+33612345678', idempotencyKey);
  });

  it('verifies an OTP under both IP and phone rate limits', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/api/auth/otp/verify',
      payload: { phone_number: '+33612345678', otp: '123456' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ access_token: 'access-token', refresh_token: 'refresh-token' });
    expect(limits.enforce).toHaveBeenNthCalledWith(
      1, 'otp-verify-ip', '127.0.0.1', { max: 5, windowMs: 3_600_000 }, 'otp_rate_limit_exceeded',
    );
    expect(limits.enforce).toHaveBeenNthCalledWith(
      2, 'otp-verify-phone', 'phone-key', { max: 5, windowMs: 3_600_000 }, 'otp_rate_limit_exceeded',
    );
    expect(auth.verifyOtp).toHaveBeenCalledWith('+33612345678', '123456');
  });

  it('keeps refresh successful response at HTTP 200', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refresh_token: '22a7d8c8-1495-40d4-8e1d-f812f66a8053:secret' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ access_token: 'next-access', refresh_token: 'next-refresh' });
  });

  it('rejects an unknown refresh payload field with the stable error format', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refresh_token: '22a7d8c8-1495-40d4-8e1d-f812f66a8053:secret', role: 'superadmin' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: 'invalid_request_body', message: 'The request body is invalid.' } });
  });

  it('revokes a session and forwards the optional device registration to remove', async () => {
    const refreshToken = '22a7d8c8-1495-40d4-8e1d-f812f66a8053:secret';
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/api/auth/logout',
      payload: { refresh_token: refreshToken, device_id: DEVICE_ID },
    });

    expect(response.statusCode).toBe(204);
    expect(auth.logout).toHaveBeenCalledWith(USER_ID, refreshToken, DEVICE_ID);
  });

  it('keeps unknown routes in the stable 404 error format', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/api/unknown-route',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'route_not_found', message: 'This route is not available.' } });
  });
});
