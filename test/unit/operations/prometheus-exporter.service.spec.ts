import { OperationalMetricsService } from '../../../src/operations/operational-metrics.service';
import { PrometheusExporterService } from '../../../src/operations/prometheus-exporter.service';

describe('PrometheusExporterService', () => {
  let metrics: OperationalMetricsService;

  beforeEach(() => {
    metrics = new OperationalMetricsService();
  });

  afterEach(() => metrics.onModuleDestroy());

  it('exports bounded counters, cumulative histograms, queues and maintenance without sensitive values', async () => {
    metrics.recordHttp('GET', '/api/users/:id"\n', 401, 12);
    metrics.recordHttp('GET', '/api/users/:id"\n', 503, 40);
    metrics.measureSync('redis', () => true);
    const operational = snapshot();
    const service = new PrometheusExporterService(
      metrics,
      { snapshot: jest.fn().mockResolvedValue(operational) } as never,
      { postgres: { max: 20 }, sms: { otpTtlMillis: 600_000 } } as never,
    );

    const rendered = await service.render(new Date('2030-01-01T00:10:00.000Z'));

    expect(rendered).toContain('histae_metrics_collection_success 1');
    expect(rendered).toContain('histae_http_requests_total{method="GET",route="/api/users/:id\\"\\n"} 2');
    expect(rendered).toContain('histae_http_request_duration_seconds_bucket{method="GET",route="/api/users/:id\\"\\n",le="0.05"} 2');
    expect(rendered).toContain('histae_http_request_duration_seconds_count{method="GET",route="/api/users/:id\\"\\n"} 2');
    expect(rendered).toContain('histae_dependency_calls_total{dependency="redis"} 1');
    expect(rendered).toContain('histae_outbox_queue_events{queue="billing_reconciliation",status="dead_letter"} 1');
    expect(rendered).toContain('histae_maintenance_overdue{job="billing"} 1');
    expect(rendered).not.toContain('user-00000000');
    expect(rendered).not.toContain('secret-value');
  });

  it('keeps in-memory metrics scrapeable when persistent collection fails', async () => {
    metrics.recordHttp('GET', '/health/ready', 503, 4);
    const service = new PrometheusExporterService(
      metrics,
      { snapshot: jest.fn().mockRejectedValue(new Error('database secret-value')) } as never,
      { postgres: { max: 20 }, sms: { otpTtlMillis: 600_000 } } as never,
    );

    const rendered = await service.render();

    expect(rendered).toContain('histae_metrics_collection_success 0');
    expect(rendered).toContain('histae_http_requests_total{method="GET",route="/health/ready"} 1');
    expect(rendered).not.toContain('database secret-value');
  });
});

function snapshot() {
  return {
    collected_at: '2030-01-01T00:10:00.000Z',
    since: '2030-01-01T00:00:00.000Z',
    runtime: { uptime_seconds: 600, memory_rss_bytes: 1_000, heap_used_bytes: 500, event_loop_delay_p95_ms: 2 },
    http: { requests: 2, errors: 2, status_401: 1, status_403: 0, status_429: 0, status_5xx: 1, routes: [] },
    dependencies: {
      postgres: dependency('ok'), redis: dependency('ok'), scylla: dependency('disabled', false),
      object_storage: dependency('unknown'), sweego: dependency('disabled', false), stripe: dependency('disabled', false),
    },
    postgres_pool: { total: 4, idle: 2, waiting: 0 },
    outbox: {
      pending: 2, processing: 0, dead_letter: 1, discarded: 0,
      oldest_pending_at: new Date('2030-01-01T00:08:00.000Z'),
      notification_push: { pending: 1, processing: 0, completed: 3, dead_letter: 0, discarded: 0, oldest_pending_at: '2030-01-01T00:08:00.000Z' },
      billing_reconciliation: { pending: 1, processing: 0, completed: 2, dead_letter: 1, oldest_pending_at: '2030-01-01T00:05:00.000Z' },
    },
    sms_delivery: {
      states: { pending: 0, accepted: 1, sent: 2, failed: 0, unknown: 0 },
      awaiting_callback: 1,
      oldest_unresolved_age_seconds: 45,
      average_acceptance_ms: 100,
      average_sent_callback_ms: 200,
      average_failure_ms: null,
      retention: 'otp_expiry' as const,
      handset_delivery: 'not_confirmed' as const,
      webhook_enabled: true,
      callbacks: { applied: 1, ignored: 0, conflict: 0, invalid_signature: 0, invalid_event: 0, unavailable: 0, disabled: 0 },
    },
    maintenance: [{
      job_name: 'billing' as const, status: 'failed' as const,
      started_at: new Date('2030-01-01T00:00:00.000Z'), finished_at: new Date('2030-01-01T00:01:00.000Z'),
      last_succeeded_at: null, duration_ms: 60_000, processed_count: 1, batch_count: 1,
      work_remaining: true, last_error_code: 'provider_error', missing: false, overdue: true,
    }],
  };
}

function dependency(status: 'disabled' | 'unknown' | 'ok' | 'error', enabled = true) {
  return { enabled, status, calls: 1, errors: 0, average_duration_ms: 1, last_success_at: null, last_error_at: null, last_error_code: null };
}
