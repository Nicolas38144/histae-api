import { Global, Module } from '@nestjs/common';
import { applicationConfig, ConfigService } from './config/config.service';
import { DatabaseService } from './database/database.service';
import { RateLimitService } from './ratelimit/rate-limit.service';
import { HealthController } from './health.controller';
import { ScyllaService } from './scylla/scylla.service';
import { RedisService } from './redis/redis.service';
import { ObjectStorageService } from './storage/object-storage.service';
import { PhotoProcessorService } from './photos/photo-processor.service';
import { PhotosRepository } from './photos/photos.repository';
import { PhotosService } from './photos/photos.service';
import { PhotosMaintenanceService } from './photos/photos-maintenance.service';
import { OutboxRepository } from './outbox/outbox.repository';
import { OutboxWorkerService } from './outbox/outbox-worker.service';
import { PhotoModerationService } from './moderation/photo-moderation.service';
import { TextModerationService } from './moderation/text-moderation.service';

@Global()
@Module({
  controllers: [HealthController],
  providers: [
    { provide: ConfigService, useFactory: applicationConfig },
    DatabaseService,
    ScyllaService,
    RedisService,
    RateLimitService,
    ObjectStorageService,
    PhotoProcessorService,
    PhotosRepository,
    PhotosService,
    PhotosMaintenanceService,
    OutboxRepository,
    OutboxWorkerService,
    PhotoModerationService,
    TextModerationService,
  ],
  exports: [
    ConfigService, DatabaseService, ScyllaService, RedisService, RateLimitService,
    ObjectStorageService, PhotoProcessorService, PhotosRepository, PhotosService,
    PhotosMaintenanceService,
    OutboxRepository, OutboxWorkerService,
    PhotoModerationService, TextModerationService,
  ],
})
export class CoreModule {}
