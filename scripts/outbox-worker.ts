import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import { applicationConfig } from '../src/config/config.service';
import { OutboxWorkerService } from '../src/outbox/outbox-worker.service';
import { formatLogEvent } from '../src/common/logging/safe-logging';
import { writeCliFailure } from './cli-output';

async function run(): Promise<void> {
  const config = applicationConfig();
  if (config.maintenanceMode !== 'worker') {
    throw new Error('The outbox worker requires MAINTENANCE_MODE=worker.');
  }

  const context = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    new Logger('OutboxWorker').log(formatLogEvent('outbox_worker_started'));
    await context.get(OutboxWorkerService).runUntilStopped(controller.signal);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await context.close();
  }
}

void run().catch((error: unknown) => {
  writeCliFailure('outbox_worker_failed', error);
  process.exitCode = 1;
});
