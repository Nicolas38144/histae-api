import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { MaintenanceJobName } from './operations.models';
import { MaintenanceStatusRepository } from './maintenance-status.repository';

@Injectable()
export class MaintenanceTrackerService {
  private readonly logger = new Logger(MaintenanceTrackerService.name);

  constructor(private readonly repository: MaintenanceStatusRepository) {}

  async track<T>(
    jobName: MaintenanceJobName,
    work: () => Promise<T>,
    processedCount: (result: T) => number,
  ): Promise<T> {
    const runId = randomUUID();
    const startedAt = new Date();
    await this.record(() => this.repository.start(jobName, runId, startedAt));
    try {
      const result = await work();
      await this.finish(jobName, runId, startedAt, result === undefined ? 'skipped' : 'succeeded', processedCount(result), null);
      return result;
    } catch (error) {
      await this.finish(jobName, runId, startedAt, 'failed', 0, maintenanceErrorCode(error));
      throw error;
    }
  }

  async recordFailure(jobName: MaintenanceJobName, error: unknown): Promise<void> {
    try {
      await this.track(jobName, async () => { throw error; }, () => 0);
    } catch {
      // track records the normalized failure; callers retain responsibility for logging it.
    }
  }

  private finish(
    jobName: MaintenanceJobName,
    runId: string,
    startedAt: Date,
    status: 'succeeded' | 'failed' | 'skipped',
    processedCount: number,
    errorCode: string | null,
  ): Promise<void> {
    const finishedAt = new Date();
    return this.record(() => this.repository.finish({
      jobName,
      runId,
      status,
      finishedAt,
      durationMs: Math.min(Math.max(0, finishedAt.getTime() - startedAt.getTime()), 86_400_000),
      processedCount: Math.max(0, Math.trunc(processedCount)),
      errorCode,
    }));
  }

  private async record(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch {
      this.logger.warn('Maintenance status could not be recorded.');
    }
  }
}

function maintenanceErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(error.code)) {
    return error.code;
  }
  return 'maintenance_execution_failed';
}
