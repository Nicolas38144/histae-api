import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import type { PrivacyMaintenanceResult } from './privacy.models';
import { PrivacyRepository } from './privacy.repository';
import { MaintenanceTrackerService } from '../operations/maintenance-tracker.service';
import { formatErrorEvent, formatLogEvent } from '../common/logging/safe-logging';

const DAY = 24 * 60 * 60 * 1_000;
const BATCH_SIZE = 1_000;
const MAX_BATCHES_PER_RUN = 100;

type PrivacyMaintenanceRun = {
  result: PrivacyMaintenanceResult;
  batchCount: number;
  workRemaining: boolean;
};

@Injectable()
export class PrivacyMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrivacyMaintenanceService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly privacy: PrivacyRepository,
    private readonly config: ConfigService,
    private readonly tracker: MaintenanceTrackerService,
  ) {}

  onModuleInit(): void {
    if (this.config.maintenanceMode !== 'api') return;
    void this.execute();
    this.timer = setInterval(() => void this.execute(), DAY);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<PrivacyMaintenanceResult | undefined> {
    const run = await this.tracker.track(
      'privacy',
      () => this.performMaintenance(),
      (run) => run
        ? {
            processedCount: Object.values(run.result).reduce((total, count) => total + count, 0),
            batchCount: run.batchCount,
            workRemaining: run.workRemaining,
          }
        : 0,
    );
    return run?.result;
  }

  private async performMaintenance(): Promise<PrivacyMaintenanceRun | undefined> {
    let totals: PrivacyMaintenanceResult | undefined;
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      const result = await this.privacy.runMaintenanceAsLeader(new Date(), BATCH_SIZE);
      if (!result) {
        return totals
          ? { result: totals, batchCount: batch, workRemaining: true }
          : undefined;
      }
      totals = merge(totals, result);
      if (Math.max(...Object.values(result)) < BATCH_SIZE) {
        return { result: totals, batchCount: batch + 1, workRemaining: false };
      }
    }
    this.logger.warn(formatLogEvent('privacy_maintenance_batch_limit', { batches: MAX_BATCHES_PER_RUN }));
    return { result: totals!, batchCount: MAX_BATCHES_PER_RUN, workRemaining: true };
  }

  private async execute(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error(formatErrorEvent('privacy_maintenance_failed', error));
    }
  }
}

function merge(current: PrivacyMaintenanceResult | undefined, next: PrivacyMaintenanceResult): PrivacyMaintenanceResult {
  const merged = { ...next };
  if (!current) return merged;
  for (const key of Object.keys(merged) as Array<keyof PrivacyMaintenanceResult>) merged[key] += current[key];
  return merged;
}
