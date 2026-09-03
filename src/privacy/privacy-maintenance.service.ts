import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import type { PrivacyMaintenanceResult } from './privacy.models';
import { PrivacyRepository } from './privacy.repository';
import { MaintenanceTrackerService } from '../operations/maintenance-tracker.service';

const DAY = 24 * 60 * 60 * 1_000;
const BATCH_SIZE = 1_000;
const MAX_BATCHES_PER_RUN = 100;

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
    return this.tracker.track(
      'privacy',
      () => this.performMaintenance(),
      (result) => result ? Object.values(result).reduce((total, count) => total + count, 0) : 0,
    );
  }

  private async performMaintenance(): Promise<PrivacyMaintenanceResult | undefined> {
    let totals: PrivacyMaintenanceResult | undefined;
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      const result = await this.privacy.runMaintenanceAsLeader(new Date(), BATCH_SIZE);
      if (!result) return totals;
      totals = merge(totals, result);
      if (Math.max(...Object.values(result)) < BATCH_SIZE) return totals;
    }
    this.logger.warn(`Privacy maintenance stopped after ${MAX_BATCHES_PER_RUN} full batches.`);
    return totals;
  }

  private async execute(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error('Privacy maintenance failed', error instanceof Error ? error.stack : undefined);
    }
  }
}

function merge(current: PrivacyMaintenanceResult | undefined, next: PrivacyMaintenanceResult): PrivacyMaintenanceResult {
  const merged = { ...next };
  if (!current) return merged;
  for (const key of Object.keys(merged) as Array<keyof PrivacyMaintenanceResult>) merged[key] += current[key];
  return merged;
}
