import { RateLimitService } from '../../../src/ratelimit/rate-limit.service';

const config = {
  phone: { hashKey: 'h'.repeat(32) },
  rateLimit: { store: 'redis' },
};

describe('RateLimitService', () => {
  it('shares Redis counters without storing the raw identifier', async () => {
    const redis = {
      enabled: true,
      incrementFixedWindow: jest.fn()
        .mockResolvedValueOnce({ count: 1, ttlMillis: 10_000 })
        .mockResolvedValueOnce({ count: 2, ttlMillis: 9_500 }),
    };
    const limits = new RateLimitService(config as never, redis as never);

    await expect(limits.enforce('messages', 'raw-user-id', { max: 1, windowMs: 10_000 }, 'message_rate_limit_exceeded'))
      .resolves.toBeUndefined();
    await expect(limits.enforce('messages', 'raw-user-id', { max: 1, windowMs: 10_000 }, 'message_rate_limit_exceeded'))
      .rejects.toMatchObject({ status: 429, code: 'message_rate_limit_exceeded', retryAfterSeconds: 10 });

    const storedKey = redis.incrementFixedWindow.mock.calls[0]?.[0] as string;
    expect(storedKey).toMatch(/^histae:rate-limit:messages:[0-9a-f]{64}$/);
    expect(storedKey).not.toContain('raw-user-id');
  });

  it('fails closed with 503 when Redis cannot protect the request', async () => {
    const redis = {
      enabled: true,
      incrementFixedWindow: jest.fn().mockRejectedValue(new Error('redis unavailable')),
    };
    const limits = new RateLimitService(config as never, redis as never);

    await expect(limits.enforce('feed', 'user-id', { max: 1, windowMs: 1_000 }, 'feed_rate_limit_exceeded'))
      .rejects.toMatchObject({ status: 503, code: 'rate_limit_unavailable' });
  });

  it('keeps the in-memory fallback isolated to non-Redis environments', async () => {
    const redis = { enabled: false, incrementFixedWindow: jest.fn() };
    const limits = new RateLimitService(config as never, redis as never);

    await limits.enforce('test', 'key', { max: 1, windowMs: 10_000 }, 'test_rate_limit');
    await expect(limits.enforce('test', 'key', { max: 1, windowMs: 10_000 }, 'test_rate_limit'))
      .rejects.toMatchObject({ status: 429, code: 'test_rate_limit' });
    expect(redis.incrementFixedWindow).not.toHaveBeenCalled();
  });

  it('periodically removes expired in-memory identifiers', async () => {
    const redis = { enabled: false, incrementFixedWindow: jest.fn() };
    const limits = new RateLimitService(config as never, redis as never);
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      for (let index = 0; index < 255; index += 1) {
        await limits.enforce('test', `expired-${index}`, { max: 1, windowMs: 1 }, 'test_rate_limit');
      }
      now.mockReturnValue(2_000);
      await limits.enforce('test', 'current', { max: 1, windowMs: 1_000 }, 'test_rate_limit');

      const memory = (limits as unknown as { memory: Map<string, unknown> }).memory;
      expect(memory.size).toBe(1);
    } finally {
      now.mockRestore();
    }
  });
});
