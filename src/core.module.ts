import { Global, Module } from '@nestjs/common';
import { applicationConfig, ConfigService } from './config/config.service';
import { DatabaseService } from './database/database.service';
import { RateLimitService } from './ratelimit/rate-limit.service';
import { HealthController } from './health.controller';
import { ScyllaService } from './scylla/scylla.service';
import { RedisService } from './redis/redis.service';

@Global()
@Module({
  controllers: [HealthController],
  providers: [
    { provide: ConfigService, useFactory: applicationConfig },
    DatabaseService,
    ScyllaService,
    RedisService,
    RateLimitService,
  ],
  exports: [ConfigService, DatabaseService, ScyllaService, RedisService, RateLimitService],
})
export class CoreModule {}
