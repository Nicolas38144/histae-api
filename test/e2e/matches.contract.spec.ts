import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { JwtActiveGuard } from '../../src/auth/auth.guard';
import { AdminSessionGuard } from '../../src/admin-auth/admin-auth.guard';
import type { AuthenticatedRequest } from '../../src/auth/auth.types';
import { ApiExceptionFilter } from '../../src/common/api-exception.filter';
import { ConfigService } from '../../src/config/config.service';
import { ContinuationController, MatchesController } from '../../src/matches/matches.controller';
import { MatchesService } from '../../src/matches/matches.service';
import { RateLimitService } from '../../src/ratelimit/rate-limit.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MATCH_ID = '22222222-2222-4222-8222-222222222222';
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333';
const IDEMPOTENCY_KEY = '44444444-4444-4444-8444-444444444444';

describe('Matches HTTP contract', () => {
  let app: NestFastifyApplication;
  const message = {
    id: MESSAGE_ID,
    match_id: MATCH_ID,
    sender_id: USER_ID,
    content: 'Bonjour !',
    created_at: new Date('2030-01-01T00:00:00.000Z'),
    read_at: null,
  };
  const matches = {
    list: jest.fn().mockResolvedValue({ items: [], next_cursor: 'next-match-cursor' }),
    reveal: jest.fn().mockResolvedValue(false),
    continue: jest.fn().mockResolvedValue(true),
    getMessages: jest.fn().mockResolvedValue({ items: [message], next_cursor: 'next-message-cursor' }),
    sendMessage: jest.fn().mockResolvedValue(message),
    markReadThrough: jest.fn().mockResolvedValue(3),
    markAsRead: jest.fn().mockResolvedValue(undefined),
    getContinuationAllowance: jest.fn().mockResolvedValue({ plan: 'free', used: 1, weekly_limit: 3, remaining: 2 }),
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
      controllers: [MatchesController, ContinuationController],
      providers: [
        { provide: MatchesService, useValue: matches },
        { provide: RateLimitService, useValue: limits },
        { provide: ConfigService, useValue: { rateLimit: { message: { max: 60, windowMs: 60_000 } } } },
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

  it('lists the authenticated account matches with cursor pagination', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET', url: '/api/matches/me?limit=12&cursor=opaque-match-cursor',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ matches: [], next_cursor: 'next-match-cursor' });
    expect(matches.list).toHaveBeenCalledWith(USER_ID, 12, 0, 'opaque-match-cursor');
  });

  it('rejects invalid match pagination before querying the service', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET', url: '/api/matches/me?limit=101',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_pagination');
    expect(matches.list).not.toHaveBeenCalled();
  });

  it('records reveal and continuation consent with explicit completion state', async () => {
    const revealed = await app.getHttpAdapter().getInstance().inject({
      method: 'PATCH', url: `/api/matches/${MATCH_ID}/reveal`,
    });
    const continued = await app.getHttpAdapter().getInstance().inject({
      method: 'PATCH', url: `/api/matches/${MATCH_ID}/continue`,
    });

    expect(revealed.statusCode).toBe(200);
    expect(revealed.json()).toEqual({ message: 'Photo reveal consent recorded.', photos_revealed: false });
    expect(continued.statusCode).toBe(200);
    expect(continued.json()).toEqual({ message: 'Both participants agreed to continue the match.', match_confirmed: true });
    expect(matches.reveal).toHaveBeenCalledWith(MATCH_ID, USER_ID);
    expect(matches.continue).toHaveBeenCalledWith(MATCH_ID, USER_ID);
  });

  it('returns cursor-paginated messages with serialized timestamps', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET', url: `/api/matches/${MATCH_ID}/messages?limit=20&cursor=opaque-message-cursor`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      messages: [{ ...message, created_at: '2030-01-01T00:00:00.000Z' }],
      next_cursor: 'next-message-cursor',
    });
    expect(matches.getMessages).toHaveBeenCalledWith(MATCH_ID, USER_ID, 20, 0, 'opaque-message-cursor');
  });

  it('sends an idempotent message under the dedicated user rate limit', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: `/api/matches/${MATCH_ID}/messages`,
      headers: { 'idempotency-key': IDEMPOTENCY_KEY },
      payload: { content: 'Bonjour !' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ ...message, created_at: '2030-01-01T00:00:00.000Z' });
    expect(limits.enforce).toHaveBeenCalledWith(
      'messages', USER_ID, { max: 60, windowMs: 60_000 }, 'message_rate_limit_exceeded',
    );
    expect(matches.sendMessage).toHaveBeenCalledWith(MATCH_ID, USER_ID, 'Bonjour !', IDEMPOTENCY_KEY);
  });

  it('rejects malformed message bodies before rate limiting or persistence', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST', url: `/api/matches/${MATCH_ID}/messages`, payload: { content: 42 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_message_payload');
    expect(limits.enforce).not.toHaveBeenCalled();
    expect(matches.sendMessage).not.toHaveBeenCalled();
  });

  it('marks messages read through a cursor and keeps the legacy single-message route', async () => {
    const grouped = await app.getHttpAdapter().getInstance().inject({
      method: 'PATCH',
      url: `/api/matches/${MATCH_ID}/messages/read`,
      payload: { read_through_message_id: MESSAGE_ID },
    });
    const single = await app.getHttpAdapter().getInstance().inject({
      method: 'PATCH', url: `/api/matches/${MATCH_ID}/messages/${MESSAGE_ID}/read`,
    });

    expect(grouped.statusCode).toBe(200);
    expect(grouped.json()).toEqual({ updated_count: 3, read_through_message_id: MESSAGE_ID });
    expect(single.statusCode).toBe(200);
    expect(single.json()).toEqual({ message: 'message marked as read' });
    expect(matches.markReadThrough).toHaveBeenCalledWith(MATCH_ID, MESSAGE_ID, USER_ID);
    expect(matches.markAsRead).toHaveBeenCalledWith(MATCH_ID, MESSAGE_ID, USER_ID);
  });

  it('returns the weekly continuation allowance for the current plan', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET', url: '/api/users/me/continuation-quota',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ plan: 'free', used: 1, weekly_limit: 3, remaining: 2 });
    expect(matches.getContinuationAllowance).toHaveBeenCalledWith(USER_ID);
  });

  it('rejects malformed match identifiers before any match operation', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'PATCH', url: '/api/matches/not-a-uuid/reveal',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_match_id');
    expect(matches.reveal).not.toHaveBeenCalled();
  });
});
