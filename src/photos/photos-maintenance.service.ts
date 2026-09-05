import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';

import { ConfigService } from '../config/config.service';
import { ObjectStorageService } from '../storage/object-storage.service';
import { PHOTO_PROCESSING_STALE_AFTER_MILLIS } from './photos.constants';
import { PhotosRepository } from './photos.repository';
import { MaintenanceTrackerService } from '../operations/maintenance-tracker.service';
import { formatErrorEvent, formatLogEvent } from '../common/logging/safe-logging';

const HOUR = 60 * 60 * 1_000;
const DELETION_RETRY_AFTER = 5 * 60 * 1_000;
const BATCH_SIZE = 100;
const MAX_BATCHES_PER_RUN = 100;

export type PhotoMaintenanceResult = {
  cleaned: number;
  failed: number;
  expiredIdempotencyRecords: number;
};

type PhotoMaintenanceRun = {
  result: PhotoMaintenanceResult;
  batchCount: number;
  workRemaining: boolean;
};

@Injectable()
export class PhotosMaintenanceService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PhotosMaintenanceService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly photos: PhotosRepository,
    private readonly storage: ObjectStorageService,
    private readonly config: ConfigService,
    private readonly tracker: MaintenanceTrackerService,
  ) {}

  onModuleInit(): void {
    if (this.config.maintenanceMode !== 'api') return;
    void this.execute();
    this.timer = setInterval(() => void this.execute(), HOUR);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<PhotoMaintenanceResult> {
    const run = await this.tracker.track(
      'photos',
      () => this.performMaintenance(),
      ({ result, batchCount, workRemaining }) => ({
        processedCount: result.cleaned + result.failed + result.expiredIdempotencyRecords,
        batchCount,
        workRemaining,
      }),
    );
    return run.result;
  }

  private async performMaintenance(): Promise<PhotoMaintenanceRun> {
    const totals: PhotoMaintenanceResult = {
      cleaned: 0,
      failed: 0,
      expiredIdempotencyRecords: 0,
    };

    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      const now = new Date();
      const expiredIdempotencyRecords = await this.photos.purgeExpiredUploadRequests(
        now,
        BATCH_SIZE,
      );
      totals.expiredIdempotencyRecords += expiredIdempotencyRecords;
      const photos = await this.photos.claimCleanupBatch(
        now,
        new Date(now.getTime() - PHOTO_PROCESSING_STALE_AFTER_MILLIS),
        new Date(now.getTime() - DELETION_RETRY_AFTER),
        BATCH_SIZE,
      );

      for (const photo of photos) {
        try {
          await this.storage.delete(photo.objectKey);
          await this.photos.completeDeletion(photo.id);
          totals.cleaned += 1;
        } catch {
          totals.failed += 1;
        }
      }

      if (photos.length < BATCH_SIZE && expiredIdempotencyRecords < BATCH_SIZE) {
        return { result: totals, batchCount: batch + 1, workRemaining: false };
      }
    }

    this.logger.warn(formatLogEvent('photo_maintenance_batch_limit', {
      batches: MAX_BATCHES_PER_RUN,
    }));
    return { result: totals, batchCount: MAX_BATCHES_PER_RUN, workRemaining: true };
  }

  private async execute(): Promise<void> {
    try {
      const result = await this.runOnce();
      if (result.failed > 0) {
        this.logger.warn(formatLogEvent('photo_maintenance_retry_pending', {
          failures: result.failed,
        }));
      }
    } catch (error: unknown) {
      this.logger.error(formatErrorEvent('photo_maintenance_failed', error));
    }
  }
}
