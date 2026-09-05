import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { applicationConfig } from '../src/config/config.service';
import { MatchMaintenanceService } from '../src/matches/match-maintenance.service';
import { PrivacyMaintenanceService } from '../src/privacy/privacy-maintenance.service';
import { PhotosMaintenanceService } from '../src/photos/photos-maintenance.service';
import { formatLogEvent } from '../src/common/logging/safe-logging';
import { writeCliFailure } from './cli-output';

async function run(): Promise<void> {
  const config = applicationConfig();
  if (config.maintenanceMode !== 'worker') {
    throw new Error('The maintenance command requires MAINTENANCE_MODE=worker.');
  }
  const context = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  try {
    const [matches, privacy, photos] = await Promise.all([
      context.get(MatchMaintenanceService).runOnce(),
      context.get(PrivacyMaintenanceService).runOnce(),
      context.get(PhotosMaintenanceService).runOnce(),
    ]);
    new Logger('Maintenance').log(formatLogEvent('maintenance_completed', {
      matches_processed: matches ? matches.opened + matches.expired + matches.purged : 0,
      privacy_processed: privacy ? Object.values(privacy).reduce((total, count) => total + count, 0) : 0,
      photos_cleaned: photos.cleaned,
      photo_failures: photos.failed,
      photos_expired_requests: photos.expiredIdempotencyRecords,
    }));
  } finally {
    await context.close();
  }
}

void run().catch((error: unknown) => {
  writeCliFailure('maintenance_failed', error);
  process.exitCode = 1;
});
