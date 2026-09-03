import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { createClient } from 'redis';
import { ConfigService } from '../config/config.service';
import { OperationalMetricsService } from '../operations/operational-metrics.service';

type RedisClient = ReturnType<typeof createClient>;

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: RedisClient;
  private readonly subscribers = new Set<RedisClient>();

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly metrics?: OperationalMetricsService,
  ) {
    const protocol = config.redis.tls ? 'rediss' : 'redis';
    this.client = createClient({
      url: `${protocol}://${config.redis.address}/${config.redis.db}`,
      password: config.redis.password || undefined,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: config.redis.connectTimeoutMillis,
        reconnectStrategy: (retries) => retries >= 5 ? new Error('Redis reconnect attempts exhausted') : Math.min(100 * 2 ** retries, 2_000),
      },
    });
    this.client.on('error', (error: Error) => this.logger.error('Redis client error', error.stack));
  }

  get enabled(): boolean {
    return this.config.rateLimit.store === 'redis';
  }

  async onModuleInit(): Promise<void> {
    if (this.enabled) await this.client.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.subscribers].map(async (subscriber) => {
      if (subscriber.isOpen) await subscriber.quit();
    }));
    this.subscribers.clear();
    if (this.client.isOpen) await this.client.quit();
  }

  async incrementFixedWindow(key: string, windowMillis: number): Promise<{ count: number; ttlMillis: number }> {
    if (!this.enabled) throw new Error('Redis is disabled');
    const result = await this.withTimeout(this.client.eval(
      "local current = redis.call('INCR', KEYS[1]); if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); end; return {current, redis.call('PTTL', KEYS[1])}",
      { keys: [key], arguments: [String(windowMillis)] },
    )) as [number, number];
    return { count: Number(result[0]), ttlMillis: Number(result[1]) };
  }

  async check(): Promise<void> {
    if (!this.enabled) return;
    await this.withTimeout(this.client.ping());
  }

  async publish(channel: string, message: string): Promise<void> {
    if (!this.enabled) throw new Error('Redis is disabled');
    await this.withTimeout(this.client.publish(channel, message));
  }

  async subscribe(channel: string, listener: (message: string) => void): Promise<() => Promise<void>> {
    if (!this.enabled) throw new Error('Redis is disabled');
    const subscriber = this.client.duplicate();
    subscriber.on('error', (error: Error) => this.logger.error('Redis subscriber error', error.stack));
    await subscriber.connect();
    await subscriber.subscribe(channel, listener);
    this.subscribers.add(subscriber);
    return async () => {
      this.subscribers.delete(subscriber);
      if (subscriber.isOpen) {
        await subscriber.unsubscribe(channel);
        await subscriber.quit();
      }
    };
  }

  private async withTimeout<T>(work: Promise<T>): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      const operation = () => Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Redis command timed out')), this.config.redis.commandTimeoutMillis);
        }),
      ]);
      return await (this.metrics?.measure('redis', operation) ?? operation());
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
