import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('observability assets', () => {
  it('pins the local stack, keeps UIs on loopback and scrapes the authenticated private listener', () => {
    const compose = fixture('docker-compose.observability.yml');
    const prometheus = fixture('observability/prometheus/prometheus.yml');

    expect(compose).toContain('prom/prometheus:v3.14.0');
    expect(compose).toContain('prom/alertmanager:v0.32.1');
    expect(compose).toContain('grafana/grafana:13.2.1');
    expect(compose).toContain('127.0.0.1:3001:3000');
    expect(compose).toContain('127.0.0.1:9090:9090');
    expect(compose).toContain('127.0.0.1:9093:9093');
    expect(prometheus).toContain('credentials_file: /run/secrets/histae_metrics_token');
    expect(prometheus).toContain('host.docker.internal:9091');
  });

  it('defines actionable bounded alerts and a valid provisioned dashboard JSON', () => {
    const alerts = fixture('observability/prometheus/alerts.yml');
    for (const alert of [
      'HistaeMetricsUnavailable', 'HistaeHttpServerErrorRateHigh', 'HistaeHttpLatencyHigh',
      'HistaeDependencyDown', 'HistaePostgresPoolWaiting', 'HistaeEventLoopDelayHigh',
      'HistaeDeadLettersPresent', 'HistaeOutboxBacklogOld', 'HistaeMaintenanceOverdue', 'HistaeMaintenanceFailed',
    ]) expect(alerts).toContain(`alert: ${alert}`);
    expect(alerts).not.toMatch(/user_id|aggregate_id|object_key/);

    const dashboard = JSON.parse(fixture('observability/grafana/dashboards/histae-operations.json')) as { uid?: string; panels?: unknown[] };
    expect(dashboard.uid).toBe('histae-operations');
    expect(dashboard.panels?.length).toBeGreaterThanOrEqual(8);
  });
});

function fixture(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}
