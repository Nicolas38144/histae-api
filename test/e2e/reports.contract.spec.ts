import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { JwtActiveGuard } from '../../src/auth/auth.guard';
import { AdminSessionGuard } from '../../src/admin-auth/admin-auth.guard';
import type { AuthenticatedRequest } from '../../src/auth/auth.types';
import { ApiExceptionFilter } from '../../src/common/api-exception.filter';
import { ConfigService } from '../../src/config/config.service';
import { RateLimitService } from '../../src/ratelimit/rate-limit.service';
import { ReportsController } from '../../src/reports/reports.controller';
import { ReportsService } from '../../src/reports/reports.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const MATCH_ID = '33333333-3333-4333-8333-333333333333';
const REPORT_ID = '44444444-4444-4444-8444-444444444444';

describe('Reports HTTP contract', () => {
  let app: NestFastifyApplication;
  const report = {
    id: REPORT_ID,
    reporter_id: USER_ID,
    reported_id: TARGET_ID,
    match_id: MATCH_ID,
    reason: 'harassment',
    description: 'Messages insistants.',
    status: 'pending',
    created_at: new Date('2030-01-01T00:00:00.000Z'),
  };
  const reports = { create: jest.fn().mockResolvedValue(report) };
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
      controllers: [ReportsController],
      providers: [
        { provide: ReportsService, useValue: reports },
        { provide: RateLimitService, useValue: limits },
        { provide: ConfigService, useValue: { rateLimit: { report: { max: 10, windowMs: 3_600_000 } } } },
      ],
    })
      .overrideGuard(JwtActiveGuard).useValue(activeGuard)
      .overrideGuard(AdminSessionGuard).useValue(activeGuard)
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
  });

  afterAll(async () => app?.close());

  beforeEach(() => jest.clearAllMocks());

  it('creates a validated report under the dedicated user rate limit', async () => {
    const payload = {
      reported_user_id: TARGET_ID,
      match_id: MATCH_ID,
      reason: 'harassment',
      description: 'Messages insistants.',
    };
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST', url: '/api/reports', payload,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ ...report, created_at: '2030-01-01T00:00:00.000Z' });
    expect(limits.enforce).toHaveBeenCalledWith(
      'reports', USER_ID, { max: 10, windowMs: 3_600_000 }, 'report_rate_limit_exceeded',
    );
    expect(reports.create).toHaveBeenCalledWith(USER_ID, payload);
  });

  it('normalizes optional report fields to null', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/api/reports',
      payload: { reported_user_id: TARGET_ID, reason: 'spam' },
    });

    expect(response.statusCode).toBe(201);
    expect(reports.create).toHaveBeenCalledWith(USER_ID, {
      reported_user_id: TARGET_ID,
      reason: 'spam',
      match_id: null,
      description: null,
    });
  });

  it('rejects invalid report targets and reasons before rate limiting', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/api/reports',
      payload: { reported_user_id: 'not-a-uuid', reason: 'I dislike this person', role: 'admin' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: {
      code: 'invalid_report_payload',
      message: 'The report request body is invalid.',
    } });
    expect(limits.enforce).not.toHaveBeenCalled();
    expect(reports.create).not.toHaveBeenCalled();
  });
});
