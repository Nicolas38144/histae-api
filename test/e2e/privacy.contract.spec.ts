import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { JwtActiveGuard } from '../../src/auth/auth.guard';
import type { AuthenticatedRequest } from '../../src/auth/auth.types';
import { ApiExceptionFilter } from '../../src/common/api-exception.filter';
import { ConfigService } from '../../src/config/config.service';
import { PrivacyController } from '../../src/privacy/privacy.controller';
import { PrivacyService } from '../../src/privacy/privacy.service';
import { RateLimitService } from '../../src/ratelimit/rate-limit.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';

describe('Privacy HTTP contract', () => {
  let app: NestFastifyApplication;
  const dataRequest = {
    id: REQUEST_ID,
    user_id: USER_ID,
    type: 'access',
    status: 'pending',
    requested_at: new Date('2030-01-01T00:00:00.000Z'),
    completed_at: null,
    handled_by: null,
    notes: null,
  };
  const blockedUser = {
    user_id: TARGET_ID,
    firstname: 'Bob',
    photo: null,
    blocked_at: new Date('2030-01-02T00:00:00.000Z'),
  };
  const exportedData = {
    exported_at: '2030-01-03T00:00:00.000Z',
    account: { user_id: USER_ID },
    profile: null,
    preferences: null,
    traits: [],
    legal_choices: [],
    matches: [],
    authored_messages: [],
    submitted_reports: [],
    blocked_users: [],
    subscription: null,
    billing_invoices: [],
    swipes: [],
  };
  const privacy = {
    createRequest: jest.fn().mockResolvedValue(dataRequest),
    requestsForUser: jest.fn().mockResolvedValue([dataRequest]),
    exportUserData: jest.fn().mockResolvedValue(exportedData),
    blockedUsers: jest.fn().mockResolvedValue([blockedUser]),
    blockUser: jest.fn().mockResolvedValue(undefined),
    unblockUser: jest.fn().mockResolvedValue(undefined),
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
      controllers: [PrivacyController],
      providers: [
        { provide: PrivacyService, useValue: privacy },
        { provide: RateLimitService, useValue: limits },
        { provide: ConfigService, useValue: { rateLimit: { dataExport: { max: 5, windowMs: 3_600_000 } } } },
      ],
    }).overrideGuard(JwtActiveGuard).useValue(activeGuard).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
  });

  afterAll(async () => app?.close());

  beforeEach(() => jest.clearAllMocks());

  it('creates and lists data subject requests for the authenticated account', async () => {
    const created = await app.getHttpAdapter().getInstance().inject({
      method: 'POST', url: '/api/users/me/data-subject-requests', payload: { type: 'access' },
    });
    const listed = await app.getHttpAdapter().getInstance().inject({
      method: 'GET', url: '/api/users/me/data-subject-requests',
    });

    const serialized = { ...dataRequest, requested_at: '2030-01-01T00:00:00.000Z' };
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual(serialized);
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ requests: [serialized] });
    expect(privacy.createRequest).toHaveBeenCalledWith(USER_ID, 'access');
    expect(privacy.requestsForUser).toHaveBeenCalledWith(USER_ID);
  });

  it('rejects unknown data subject request types', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST', url: '/api/users/me/data-subject-requests', payload: { type: 'sell_my_data' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: {
      code: 'invalid_data_request',
      message: 'The data subject request is invalid.',
    } });
    expect(privacy.createRequest).not.toHaveBeenCalled();
  });

  it('rate limits and returns the portable data export', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET', url: '/api/users/me/data-export',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(exportedData);
    expect(limits.enforce).toHaveBeenCalledWith(
      'data-export', USER_ID, { max: 5, windowMs: 3_600_000 }, 'data_export_rate_limit_exceeded',
    );
    expect(privacy.exportUserData).toHaveBeenCalledWith(USER_ID);
  });

  it('lists blocked users without exposing unrelated account data', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET', url: '/api/users/me/blocks',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ blocks: [{ ...blockedUser, blocked_at: '2030-01-02T00:00:00.000Z' }] });
    expect(response.json().blocks[0]).toEqual({
      user_id: TARGET_ID,
      firstname: 'Bob',
      photo: null,
      blocked_at: '2030-01-02T00:00:00.000Z',
    });
    expect(privacy.blockedUsers).toHaveBeenCalledWith(USER_ID);
  });

  it('blocks and unblocks only the validated target account', async () => {
    const blocked = await app.getHttpAdapter().getInstance().inject({
      method: 'POST', url: `/api/users/me/blocks/${TARGET_ID}`,
    });
    const unblocked = await app.getHttpAdapter().getInstance().inject({
      method: 'DELETE', url: `/api/users/me/blocks/${TARGET_ID}`,
    });

    expect(blocked.statusCode).toBe(204);
    expect(unblocked.statusCode).toBe(204);
    expect(privacy.blockUser).toHaveBeenCalledWith(USER_ID, TARGET_ID);
    expect(privacy.unblockUser).toHaveBeenCalledWith(USER_ID, TARGET_ID);
  });

  it('rejects malformed block targets before any privacy mutation', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST', url: '/api/users/me/blocks/not-a-uuid',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_user_id');
    expect(privacy.blockUser).not.toHaveBeenCalled();
  });
});
