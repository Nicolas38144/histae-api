import { Injectable } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import type { OperationalSnapshot } from './operations.models';
import {
  OPERATION_DURATION_BUCKETS_MS,
  OperationalMetricsService,
  type PrometheusMetricsSnapshot,
} from './operational-metrics.service';
import { OperationalStatusService } from './operational-status.service';

type Labels = Readonly<Record<string, string>>;

@Injectable()
export class PrometheusExporterService {
  constructor(
    private readonly metrics: OperationalMetricsService,
    private readonly status: OperationalStatusService,
    private readonly config: ConfigService,
  ) {}

  async render(now = new Date()): Promise<string> {
    let operational: OperationalSnapshot | null = null;
    try {
      operational = await this.status.snapshot(now);
    } catch {
      // The in-memory series must remain scrapeable when PostgreSQL is the failed dependency.
    }
    const aggregate = this.metrics.prometheusSnapshot();
    const lines: string[] = [];
    renderProcessMetrics(lines, operational, aggregate, now);
    renderHttpMetrics(lines, aggregate);
    renderDependencyMetrics(lines, aggregate, operational);
    if (operational) this.renderPersistentMetrics(lines, operational, now);
    return `${lines.join('\n')}\n`;
  }

  private renderPersistentMetrics(lines: string[], snapshot: OperationalSnapshot, now: Date): void {
    gauge(lines, 'histae_postgres_pool_connections', 'PostgreSQL pool connections by state.', snapshot.postgres_pool.total, { state: 'total' });
    gauge(lines, 'histae_postgres_pool_connections', 'PostgreSQL pool connections by state.', snapshot.postgres_pool.idle, { state: 'idle' }, false);
    gauge(lines, 'histae_postgres_pool_connections', 'PostgreSQL pool connections by state.', snapshot.postgres_pool.waiting, { state: 'waiting' }, false);
    gauge(lines, 'histae_postgres_pool_max_connections', 'Configured PostgreSQL application pool limit.', this.config.postgres.max);

    const outbox = snapshot.outbox;
    for (const [status, value] of Object.entries({
      pending: outbox.pending,
      processing: outbox.processing,
      dead_letter: outbox.dead_letter,
      discarded: outbox.discarded,
    })) gauge(lines, 'histae_outbox_events', 'Current outbox events by status.', value, { status }, status === 'pending');
    gauge(lines, 'histae_outbox_oldest_pending_age_seconds', 'Age of the oldest pending outbox event.', ageSeconds(outbox.oldest_pending_at, now));
    renderOutboxQueue(lines, 'notification_push', outbox.notification_push, now);
    renderOutboxQueue(lines, 'billing_reconciliation', outbox.billing_reconciliation, now);

    for (const [state, value] of Object.entries(snapshot.sms_delivery.states)) {
      gauge(lines, 'histae_sweego_otp_deliveries', 'Unexpired OTP deliveries by state.', value, { state }, state === 'pending');
    }
    gauge(lines, 'histae_sweego_awaiting_callback', 'Accepted OTP deliveries still awaiting a provider callback.', snapshot.sms_delivery.awaiting_callback);
    gauge(lines, 'histae_sweego_oldest_unresolved_age_seconds', 'Age of the oldest unresolved OTP delivery.', snapshot.sms_delivery.oldest_unresolved_age_seconds ?? 0);
    gauge(lines, 'histae_sweego_otp_ttl_seconds', 'Configured OTP lifetime.', this.config.sms.otpTtlMillis / 1_000);
    gauge(lines, 'histae_sweego_webhook_enabled', 'Whether authenticated Sweego callbacks are enabled.', snapshot.sms_delivery.webhook_enabled ? 1 : 0);
    for (const [outcome, value] of Object.entries(snapshot.sms_delivery.callbacks)) {
      counter(lines, 'histae_sweego_webhook_callbacks_total', 'Sweego webhook callbacks by bounded outcome.', value, { outcome }, outcome === 'applied');
    }

    for (const job of snapshot.maintenance) {
      const labels = { job: job.job_name };
      gauge(lines, 'histae_maintenance_missing', 'Whether no persistent run exists for the maintenance job.', job.missing ? 1 : 0, labels, job.job_name === 'matches');
      gauge(lines, 'histae_maintenance_overdue', 'Whether the maintenance job is overdue or stuck.', job.overdue ? 1 : 0, labels, false);
      gauge(lines, 'histae_maintenance_work_remaining', 'Whether the last maintenance pass reached its work budget.', job.work_remaining ? 1 : 0, labels, false);
      for (const status of ['running', 'succeeded', 'failed', 'skipped', 'missing'] as const) {
        gauge(lines, 'histae_maintenance_last_run_status', 'Last maintenance run status as a one-hot value.',
          (job.status ?? 'missing') === status ? 1 : 0, { ...labels, status },
          job.job_name === 'matches' && status === 'running');
      }
      gauge(lines, 'histae_maintenance_last_duration_seconds', 'Duration of the last maintenance pass.', (job.duration_ms ?? 0) / 1_000, labels, job.job_name === 'matches');
      gauge(lines, 'histae_maintenance_last_processed', 'Items processed by the last maintenance pass.', job.processed_count, labels, job.job_name === 'matches');
      gauge(lines, 'histae_maintenance_last_batches', 'Batches processed by the last maintenance pass.', job.batch_count, labels, job.job_name === 'matches');
      gauge(lines, 'histae_maintenance_last_success_timestamp_seconds', 'Unix timestamp of the last successful maintenance pass.', timestampSeconds(job.last_succeeded_at), labels, job.job_name === 'matches');
    }
  }
}

function renderProcessMetrics(
  lines: string[],
  status: OperationalSnapshot | null,
  aggregate: PrometheusMetricsSnapshot,
  now: Date,
): void {
  const runtime = status?.runtime;
  gauge(lines, 'histae_metrics_collection_success', 'Whether persistent operational state was collected for this scrape.', status ? 1 : 0);
  gauge(lines, 'histae_process_start_time_seconds', 'Unix timestamp when this API process started.', aggregate.startedAt.getTime() / 1_000);
  gauge(lines, 'histae_process_uptime_seconds', 'API process uptime.', Math.max(0, (now.getTime() - aggregate.startedAt.getTime()) / 1_000));
  if (!runtime) return;
  gauge(lines, 'histae_process_resident_memory_bytes', 'Resident memory used by the API process.', runtime.memory_rss_bytes);
  gauge(lines, 'histae_process_heap_used_bytes', 'JavaScript heap used by the API process.', runtime.heap_used_bytes);
  gauge(lines, 'histae_nodejs_event_loop_delay_p95_seconds', 'Event-loop delay p95 sampled by the API process.', runtime.event_loop_delay_p95_ms / 1_000);
}

function renderHttpMetrics(lines: string[], snapshot: PrometheusMetricsSnapshot): void {
  for (const route of snapshot.http) {
    const labels = { method: route.method, route: route.route };
    counter(lines, 'histae_http_requests_total', 'HTTP requests by normalized route and method.', route.requests, labels, route === snapshot.http[0]);
    counter(lines, 'histae_http_errors_total', 'HTTP responses with status 4xx or 5xx.', route.errors, labels, route === snapshot.http[0]);
    for (const [status, value] of Object.entries({
      '401': route.status401,
      '403': route.status403,
      '429': route.status429,
      '5xx': route.status5xx,
    })) counter(lines, 'histae_http_responses_total', 'Security-relevant and server-error HTTP responses.', value, { ...labels, status }, route === snapshot.http[0] && status === '401');
    histogram(lines, 'histae_http_request_duration_seconds', 'HTTP request duration.', route.durationBuckets, route.totalDurationMs / 1_000, route.requests, labels, route === snapshot.http[0]);
  }
}

function renderDependencyMetrics(
  lines: string[],
  snapshot: PrometheusMetricsSnapshot,
  status: OperationalSnapshot | null,
): void {
  for (const dependency of snapshot.dependencies) {
    const labels = { dependency: dependency.name };
    const current = status?.dependencies[dependency.name];
    gauge(lines, 'histae_dependency_enabled', 'Whether the dependency is configured for this process.', current?.enabled === false ? 0 : 1, labels, dependency === snapshot.dependencies[0]);
    gauge(lines, 'histae_dependency_up', 'Whether the last observed dependency operation succeeded.', current?.status === 'ok' ? 1 : 0, labels, dependency === snapshot.dependencies[0]);
    counter(lines, 'histae_dependency_calls_total', 'Dependency calls by bounded dependency name.', dependency.calls, labels, dependency === snapshot.dependencies[0]);
    counter(lines, 'histae_dependency_errors_total', 'Dependency call failures by bounded dependency name.', dependency.errors, labels, dependency === snapshot.dependencies[0]);
    histogram(lines, 'histae_dependency_call_duration_seconds', 'Dependency call duration.', dependency.durationBuckets, dependency.totalDurationMs / 1_000, dependency.calls, labels, dependency === snapshot.dependencies[0]);
    gauge(lines, 'histae_dependency_last_success_timestamp_seconds', 'Unix timestamp of the last successful dependency operation.', timestampSeconds(dependency.lastSuccessAt), labels, dependency === snapshot.dependencies[0]);
    gauge(lines, 'histae_dependency_last_error_timestamp_seconds', 'Unix timestamp of the last failed dependency operation.', timestampSeconds(dependency.lastErrorAt), labels, dependency === snapshot.dependencies[0]);
  }
}

function renderOutboxQueue(
  lines: string[],
  queue: string,
  values: {
    pending: number;
    processing: number;
    completed: number;
    dead_letter: number;
    discarded?: number;
    oldest_pending_at: string | null;
  },
  now: Date,
): void {
  for (const status of ['pending', 'processing', 'completed', 'dead_letter', 'discarded'] as const) {
    if (typeof values[status] === 'number') {
      gauge(lines, 'histae_outbox_queue_events', 'Current outbox events in operational queues.', values[status] as number, { queue, status }, queue === 'notification_push' && status === 'pending');
    }
  }
  gauge(lines, 'histae_outbox_queue_oldest_pending_age_seconds', 'Age of the oldest pending event in an operational queue.', ageSeconds(values.oldest_pending_at, now), { queue }, queue === 'notification_push');
}

function histogram(
  lines: string[], name: string, help: string, buckets: readonly number[], sum: number, count: number,
  labels: Labels, describe: boolean,
): void {
  if (describe) description(lines, name, help, 'histogram');
  let cumulative = 0;
  for (let index = 0; index < OPERATION_DURATION_BUCKETS_MS.length; index += 1) {
    cumulative += buckets[index] ?? 0;
    const upperBound = OPERATION_DURATION_BUCKETS_MS[index]!;
    sample(lines, `${name}_bucket`, cumulative, { ...labels, le: Number.isFinite(upperBound) ? String(upperBound / 1_000) : '+Inf' });
  }
  sample(lines, `${name}_sum`, sum, labels);
  sample(lines, `${name}_count`, count, labels);
}

function counter(lines: string[], name: string, help: string, value: number, labels: Labels = {}, describe = true): void {
  if (describe) description(lines, name, help, 'counter');
  sample(lines, name, value, labels);
}

function gauge(lines: string[], name: string, help: string, value: number, labels: Labels = {}, describe = true): void {
  if (describe) description(lines, name, help, 'gauge');
  sample(lines, name, value, labels);
}

function description(lines: string[], name: string, help: string, type: 'counter' | 'gauge' | 'histogram'): void {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
}

function sample(lines: string[], name: string, value: number, labels: Labels): void {
  const labelText = Object.entries(labels).map(([key, label]) => `${key}="${escapeLabel(label)}"`).join(',');
  lines.push(`${name}${labelText ? `{${labelText}}` : ''} ${Number.isFinite(value) ? value : 0}`);
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function timestampSeconds(value: Date | string | null): number {
  if (!value) return 0;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp / 1_000 : 0;
}

function ageSeconds(value: Date | string | number | null | undefined, now: Date): number {
  if (!value) return 0;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(timestamp) ? Math.max(0, (now.getTime() - timestamp) / 1_000) : 0;
}
