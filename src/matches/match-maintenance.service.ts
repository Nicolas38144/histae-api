import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import type { MaintenanceResult } from './matches.models';
import { MatchMaintenanceRepository } from './match-maintenance.repository';
import { MaintenanceTrackerService } from '../operations/maintenance-tracker.service';
import { formatErrorEvent } from '../common/logging/safe-logging';

const HOUR = 60 * 60 * 1_000;

@Injectable()
export class MatchMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MatchMaintenanceService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly matches: MatchMaintenanceRepository,
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

  async runOnce(): Promise<MaintenanceResult | undefined> {
    return this.tracker.track(
      'matches',
      () => this.matches.runMaintenanceAsLeader(new Date()),
      (result) => result ? result.opened + result.expired + result.purged : 0,
    );
  }

  private async execute(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error(formatErrorEvent('match_maintenance_failed', error));
    }
  }
}
