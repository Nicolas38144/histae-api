import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { JwtActiveGuard } from '../../src/auth/auth.guard';
import type { AuthenticatedRequest } from '../../src/auth/auth.types';
import { apiError } from '../../src/common/api-error';
import { ApiExceptionFilter } from '../../src/common/api-exception.filter';
import { ConfigService } from '../../src/config/config.service';
import { DiscoveryController } from '../../src/discovery/discovery.controller';
import { DiscoveryService } from '../../src/discovery/discovery.service';
import { RateLimitService } from '../../src/ratelimit/rate-limit.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';

describe('Discovery HTTP contract', () => {
  let app: NestFastifyApplication;
  const discovery = {
    swipe: jest.fn().mockResolvedValue({ decision: 'like', matched: false }),
    feed: jest.fn().mockResolvedValue({ profiles: [], next_cursor: null }),
    status: jest.fn().mockResolvedValue({ ready: false, required_actions: ['fresh_presence'], presence_expires_at: null }),
  };
  const limits = { enforce: jest.fn() };
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
      controllers: [DiscoveryController],
      providers: [
        { provide: DiscoveryService, useValue: discovery },
        { provide: RateLimitService, useValue: limits },
        { provide: ConfigService, useValue: { rateLimit: {
          swipe: { max: 120, windowMs: 60_000 },
          feed: { max: 60, windowMs: 60_000 },
        } } },
      ],
    }).overrideGuard(JwtActiveGuard).useValue(activeGuard).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
  });

  afterAll(async () => app?.close());

  beforeEach(() => jest.clearAllMocks());

  it('exposes the authenticated discovery prerequisites without consuming feed quota', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/api/users/me/discovery-status',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ready: false, required_actions: ['fresh_presence'], presence_expires_at: null });
    expect(discovery.status).toHaveBeenCalledWith(USER_ID);
    expect(limits.enforce).not.toHaveBeenCalled();
  });

  it('records a validated swipe and applies its dedicated rate limit', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/api/swipes',
      payload: { target_user_id: TARGET_ID, decision: 'like' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ decision: 'like', matched: false });
    expect(discovery.swipe).toHaveBeenCalledWith(USER_ID, TARGET_ID, 'like');
    expect(limits.enforce).toHaveBeenCalledWith('swipes', USER_ID, expect.any(Object), 'swipe_rate_limit_exceeded');
  });

  it('rejects malformed swipe payloads before the service', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/api/swipes',
      payload: { target_user_id: 'not-a-uuid', decision: 'super-like' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: 'invalid_swipe_payload', message: 'The swipe request body is invalid.' } });
    expect(discovery.swipe).not.toHaveBeenCalled();
  });

  it('converts and forwards feed pagination parameters', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/api/feed?limit=12&cursor=opaque-cursor',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ profiles: [], next_cursor: null });
    expect(discovery.feed).toHaveBeenCalledWith(USER_ID, 12, 'opaque-cursor');
  });

  it('returns the stable 503 envelope when ScyllaDB is unavailable', async () => {
    discovery.swipe.mockRejectedValueOnce(apiError(503, 'discovery_unavailable', 'Discovery is temporarily unavailable.'));

    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/api/swipes',
      payload: { target_user_id: TARGET_ID, decision: 'like' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: { code: 'discovery_unavailable', message: 'Discovery is temporarily unavailable.' },
    });
  });

  it('no longer exposes the development fake-match route', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/api/fake-match',
      payload: { user1_id: USER_ID, user2_id: TARGET_ID },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'route_not_found', message: 'This route is not available.' } });
  });
});
