import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { JwtService } from '@nestjs/jwt';
import { AuthController } from '../../src/auth/auth.controller';
import { DevelopmentOnlyGuard, JwtActiveGuard } from '../../src/auth/auth.guard';
import { AuthService } from '../../src/auth/auth.service';
import { ApiExceptionFilter } from '../../src/common/api-exception.filter';
import { ConfigService } from '../../src/config/config.service';
import { DatabaseService } from '../../src/database/database.service';
import { RateLimitService } from '../../src/ratelimit/rate-limit.service';
import { OtpService } from '../../src/auth/otp.service';

describe('Auth HTTP contract', () => {
  let app: NestFastifyApplication;
  const auth = {
    refresh: jest.fn().mockResolvedValue({ access_token: 'next-access', refresh_token: 'next-refresh' }),
    bootstrapSuperadmin: jest.fn().mockResolvedValue({ user_id: 'c88624dd-3bd1-43d8-9991-7e6211b3f0e5', access_token: 'admin-access', refresh_token: 'admin-refresh' }),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: RateLimitService, useValue: { enforce: jest.fn() } },
        { provide: ConfigService, useValue: { env: 'development', rateLimit: { refresh: { max: 30, windowMs: 900_000 } } } },
        { provide: OtpService, useValue: { rateLimitKey: jest.fn().mockReturnValue('phone-key') } },
        { provide: JwtActiveGuard, useValue: { canActivate: () => true } },
        { provide: DevelopmentOnlyGuard, useValue: { canActivate: () => true } },
        { provide: JwtService, useValue: {} },
        { provide: DatabaseService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
  });

  afterAll(async () => app?.close());

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

  it('rejects caller-controlled roles during development registration', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { phone_number: '+33612345678', role: 'superadmin' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: 'invalid_request_body', message: 'The request body is invalid.' } });
  });

  it('keeps unknown routes in the stable 404 error format', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/api/unknown-route',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'route_not_found', message: 'This route is not available.' } });
  });

  it('exposes the development-only bootstrap through an HTTP endpoint', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/api/auth/dev/bootstrap-superadmin',
      headers: { 'x-dev-bootstrap-secret': 'development-secret' },
      payload: { phone_number: '+33612345678' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ user_id: 'c88624dd-3bd1-43d8-9991-7e6211b3f0e5', access_token: 'admin-access', refresh_token: 'admin-refresh' });
    expect(auth.bootstrapSuperadmin).toHaveBeenCalledWith('+33612345678', 'development-secret');
  });
});
