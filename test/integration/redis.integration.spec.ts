import { randomUUID } from 'node:crypto';
import * as dotenv from 'dotenv';
import type { ConfigService } from '../../src/config/config.service';
import { RateLimitService } from '../../src/ratelimit/rate-limit.service';
import { RedisService } from '../../src/redis/redis.service';

dotenv.config();

const REQUIRED = process.env.REQUIRE_REDIS_TESTS === 'true';
const TEST_REDIS_DB = Number(process.env.TEST_REDIS_DB ?? 15);
const describeRedis = REQUIRED ? describe : describe.skip;

if (REQUIRED && TEST_REDIS_DB !== 15) {
  throw new Error('Redis integration tests only allow TEST_REDIS_DB=15.');
}

describeRedis('Redis distributed request protection', () => {
  let firstRedis: RedisService;
  let secondRedis: RedisService;
  let firstLimits: RateLimitService;
  let secondLimits: RateLimitService;

  beforeAll(async () => {
    const config = redisTestConfig();
    firstRedis = new RedisService(config);
    secondRedis = new RedisService(config);
    await Promise.all([firstRedis.onModuleInit(), secondRedis.onModuleInit()]);
    firstLimits = new RateLimitService(config, firstRedis);
    secondLimits = new RateLimitService(config, secondRedis);
  });

  afterAll(async () => {
    await Promise.all([firstRedis?.onModuleDestroy(), secondRedis?.onModuleDestroy()]);
  });

  it('answers PING through the application service', async () => {
    await expect(firstRedis.check()).resolves.toBeUndefined();
  });

  it('shares one atomic fixed-window counter between two API instances', async () => {
    const identifier = randomUUID();
    const policy = { max: 1, windowMs: 2_000 };

    await expect(firstLimits.enforce('integration', identifier, policy, 'integration_rate_limit'))
      .resolves.toBeUndefined();
    await expect(secondLimits.enforce('integration', identifier, policy, 'integration_rate_limit'))
      .rejects.toMatchObject({ status: 429, code: 'integration_rate_limit', retryAfterSeconds: 2 });
  });
});

function redisTestConfig(): ConfigService {
  return {
    redis: {
      address: process.env.TEST_REDIS_ADDR ?? '127.0.0.1:6379',
      password: process.env.TEST_REDIS_PASSWORD ?? '',
      db: TEST_REDIS_DB,
      tls: false,
      connectTimeoutMillis: 5_000,
      commandTimeoutMillis: 1_000,
    },
    phone: { hashKey: 'redis-integration-key-material-32' },
    rateLimit: { store: 'redis' },
  } as ConfigService;
}

