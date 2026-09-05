import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import { DatabaseService } from '../database/database.service';
import { OutboxRepository } from '../outbox/outbox.repository';
import { MaintenanceStatusRepository } from './maintenance-status.repository';
import type {
  MaintenanceJobName,
  MaintenanceJobOperationalView,
  MaintenanceJobSnapshot,
  OperationalSnapshot,
} from './operations.models';
import { MAINTENANCE_JOB_NAMES } from './operations.models';
import { OperationalMetricsService } from './operational-metrics.service';
import { OtpRepository } from '../auth/otp.repository';
import { SweegoWebhookMetricsService } from '../auth/sweego-webhook-metrics.service';

const EXPECTED_INTERVAL_MILLIS: Record<MaintenanceJobName, number> = {
  matches: 60 * 60 * 1_000,
  photos: 60 * 60 * 1_000,
  privacy: 24 * 60 * 60 * 1_000,
  outbox: 60 * 1_000,
  billing: 5 * 60 * 1_000,
};

@Injectable()
export class OperationalStatusService {
  constructor(
    private readonly metrics: OperationalMetricsService,
    private readonly database: DatabaseService,
    private readonly outbox: OutboxRepository,
    private readonly maintenance: MaintenanceStatusRepository,
    private readonly config: ConfigService,
    private readonly otp: OtpRepository,
    private readonly smsWebhooks: SweegoWebhookMetricsService,
  ) {}

  async snapshot(now = new Date()): Promise<OperationalSnapshot> {
    const [outbox, recordedJobs, smsDelivery] = await Promise.all([
      this.outbox.statusSnapshot(),
      this.maintenance.list(),
      this.otp.statusSnapshot(),
    ]);
    const jobs = new Map(recordedJobs.map((job) => [job.job_name, job]));
    return {
      collected_at: now.toISOString(),
      since: this.metrics.startedAt.toISOString(),
      runtime: this.metrics.runtimeSnapshot(),
      http: this.metrics.httpSnapshot(),
      dependencies: this.metrics.dependencySnapshot({
        redis: this.config.rateLimit.store === 'redis',
        scylla: this.config.scylla.enabled,
        sweego: this.config.sms.provider === 'sweego',
        stripe: this.config.billing.provider === 'stripe',
      }),
      postgres_pool: this.database.poolStats(),
      outbox,
      sms_delivery: { ...smsDelivery, webhook_enabled: this.config.sms.provider === 'sweego' && !!this.config.sms.webhookSecret,
        callbacks: this.smsWebhooks.snapshot() },
      maintenance: MAINTENANCE_JOB_NAMES.map((jobName) => maintenanceView(
        jobName,
        jobs.get(jobName),
        now,
        jobName === 'billing'
          ? this.config.billing.reconciliationIntervalMillis ?? EXPECTED_INTERVAL_MILLIS.billing
          : EXPECTED_INTERVAL_MILLIS[jobName],
      )),
    };
  }
}

function maintenanceView(
  jobName: MaintenanceJobName,
  snapshot: MaintenanceJobSnapshot | undefined,
  now: Date,
  expectedIntervalMillis: number,
): MaintenanceJobOperationalView {
  if (!snapshot) return {
    job_name: jobName,
    status: null,
    started_at: null,
    finished_at: null,
    last_succeeded_at: null,
    duration_ms: null,
    processed_count: 0,
    last_error_code: null,
    missing: true,
    overdue: true,
  };
  const reference = snapshot.finished_at ?? snapshot.started_at;
  return {
    ...snapshot,
    missing: false,
    overdue: (snapshot.status === 'running' && now.getTime() - snapshot.started_at.getTime() > expectedIntervalMillis)
      || now.getTime() - reference.getTime() > expectedIntervalMillis * 2,
  };
}
