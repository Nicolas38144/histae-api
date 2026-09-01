import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { applicationConfig } from '../src/config/config.service';
import { MatchMaintenanceService } from '../src/matches/match-maintenance.service';
import { PrivacyMaintenanceService } from '../src/privacy/privacy-maintenance.service';
import { PhotosMaintenanceService } from '../src/photos/photos-maintenance.service';

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
    new Logger('Maintenance').log(JSON.stringify({
      matches: matches ?? null,
      privacy: privacy ?? null,
      photos,
    }));
  } finally {
    await context.close();
  }
}

void run().catch((error: unknown) => {
  console.error('Maintenance failed:', error);
  process.exitCode = 1;
});
