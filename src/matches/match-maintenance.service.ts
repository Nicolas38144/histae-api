import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import type { MaintenanceResult } from './matches.models';
import { MatchesRepository } from './matches.repository';

const HOUR = 60 * 60 * 1_000;

@Injectable()
export class MatchMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MatchMaintenanceService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly matches: MatchesRepository, private readonly config: ConfigService) {}

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
    return this.matches.runMaintenanceAsLeader(new Date());
  }

  private async execute(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error('Match maintenance failed', error instanceof Error ? error.stack : undefined);
    }
  }
}
