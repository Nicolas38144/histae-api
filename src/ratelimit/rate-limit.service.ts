import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ApiError, apiError } from '../common/api-error';
import type { LimitPolicy } from '../config/config.service';
import { ConfigService } from '../config/config.service';
import { RedisService } from '../redis/redis.service';

type MemoryEntry = { count: number; expiresAt: number };
@Injectable()
export class RateLimitService {
  private readonly memory = new Map<string, MemoryEntry>();

  constructor(private readonly config: ConfigService, private readonly redis: RedisService) {}

  async enforce(name: string, key: string, policy: LimitPolicy, code: string): Promise<void> {
    try {
      const storageKey = this.storageKey(name, key);
      const retryAfterMs = this.redis.enabled
        ? await this.redisAllow(storageKey, policy)
        : this.memoryAllow(storageKey, policy);
      if (retryAfterMs !== undefined) {
        throw apiError(429, code, 'Too many requests were sent. Please try again later.', undefined, Math.max(1, Math.ceil(retryAfterMs / 1_000)));
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw apiError(503, 'rate_limit_unavailable', 'Request protection is temporarily unavailable.', error);
    }
  }

  private memoryAllow(key: string, policy: LimitPolicy): number | undefined {
    const now = Date.now();
    let entry = this.memory.get(key);
    if (!entry || now >= entry.expiresAt) entry = { count: 0, expiresAt: now + policy.windowMs };
    entry.count += 1;
    this.memory.set(key, entry);
    return entry.count > policy.max ? entry.expiresAt - now : undefined;
  }

  private async redisAllow(key: string, policy: LimitPolicy): Promise<number | undefined> {
    const result = await this.redis.incrementFixedWindow(key, policy.windowMs);
    return result.count > policy.max ? result.ttlMillis : undefined;
  }

  private storageKey(name: string, key: string): string {
    const digest = createHmac('sha256', this.config.phone.hashKey).update(`${name}:${key}`, 'utf8').digest('hex');
    return `histae:rate-limit:${name}:${digest}`;
  }
}
