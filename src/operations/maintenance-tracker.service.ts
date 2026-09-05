import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { MaintenanceJobName } from './operations.models';
import { MaintenanceStatusRepository } from './maintenance-status.repository';
import { safeErrorCode } from '../common/logging/safe-logging';

export type MaintenanceProgress = {
  processedCount: number;
  batchCount?: number;
  workRemaining?: boolean;
};

@Injectable()
export class MaintenanceTrackerService {
  private readonly logger = new Logger(MaintenanceTrackerService.name);

  constructor(private readonly repository: MaintenanceStatusRepository) {}

  async track<T>(
    jobName: MaintenanceJobName,
    work: () => Promise<T>,
    progress: (result: T) => number | MaintenanceProgress,
  ): Promise<T> {
    const runId = randomUUID();
    const startedAt = new Date();
    await this.record(() => this.repository.start(jobName, runId, startedAt));
    try {
      const result = await work();
      const skipped = result === undefined;
      const outcome = skipped
        ? { processedCount: 0, batchCount: 0, workRemaining: false }
        : normalizeProgress(progress(result));
      await this.finish(
        jobName,
        runId,
        startedAt,
        skipped ? 'skipped' : 'succeeded',
        outcome,
        null,
      );
      return result;
    } catch (error) {
      await this.finish(
        jobName,
        runId,
        startedAt,
        'failed',
        { processedCount: 0, batchCount: 0, workRemaining: true },
        maintenanceErrorCode(error),
      );
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
    progress: Required<MaintenanceProgress>,
    errorCode: string | null,
  ): Promise<void> {
    const finishedAt = new Date();
    return this.record(() => this.repository.finish({
      jobName,
      runId,
      status,
      finishedAt,
      durationMs: Math.min(Math.max(0, finishedAt.getTime() - startedAt.getTime()), 86_400_000),
      processedCount: progress.processedCount,
      batchCount: progress.batchCount,
      workRemaining: progress.workRemaining,
      errorCode,
    }));
  }

  private async record(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch {
      this.logger.warn('maintenance_status_record_failed');
    }
  }
}

function normalizeProgress(progress: number | MaintenanceProgress): Required<MaintenanceProgress> {
  const value = typeof progress === 'number' ? { processedCount: progress } : progress;
  return {
    processedCount: Math.max(0, Math.trunc(value.processedCount)),
    batchCount: Math.max(0, Math.trunc(value.batchCount ?? 1)),
    workRemaining: value.workRemaining ?? false,
  };
}

function maintenanceErrorCode(error: unknown): string {
  return safeErrorCode(error, 'maintenance_execution_failed');
}
