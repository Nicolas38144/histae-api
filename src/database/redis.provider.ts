import { Provider } from '@nestjs/common';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';

export const redisProvider: Provider = {
  provide: 'REDIS',
  useFactory: (config: ConfigService) => {
    const redis = config.get('app.redis');
    const client = new Redis({
      host: redis.REDIS_HOST,
      port: redis.REDIS_PORT,
      password: redis.REDIS_PASSWORD || undefined,
    });

    client.on('connect', () => console.log('✅ Connected to Redis'));
    client.on('ready', () => console.log('✅ Redis ready'));
    client.on('error', (err) => console.error('❌ Redis connection error', err));

    return client;
  },
  inject: [ConfigService],
};
