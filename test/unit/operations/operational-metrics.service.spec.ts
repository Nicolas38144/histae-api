import { OperationalMetricsService } from '../../../src/operations/operational-metrics.service';

describe('OperationalMetricsService', () => {
  let metrics: OperationalMetricsService;

  beforeEach(() => {
    metrics = new OperationalMetricsService();
  });

  afterEach(() => metrics.onModuleDestroy());

  it('aggregates bounded HTTP route latency and security-relevant statuses', () => {
    metrics.recordHttp('GET', '/api/users/:id', 200, 12);
    metrics.recordHttp('GET', '/api/users/:id', 401, 40);
    metrics.recordHttp('POST', '/api/messages', 503, 600);

    expect(metrics.httpSnapshot()).toEqual(expect.objectContaining({
      requests: 3,
      errors: 2,
      status_401: 1,
      status_403: 0,
      status_429: 0,
      status_5xx: 1,
      routes: expect.arrayContaining([
        expect.objectContaining({ route: '/api/users/:id', requests: 2, p95_duration_ms: 50 }),
      ]),
    }));
  });

  it('records dependency success and sanitized failures without swallowing errors', async () => {
    await expect(metrics.measure('stripe', async () => 'ok')).resolves.toBe('ok');
    await expect(metrics.measure('stripe', async () => {
      const error = new Error('provider secret');
      Object.assign(error, { code: 'provider_timeout' });
      throw error;
    })).rejects.toThrow('provider secret');

    expect(metrics.dependencySnapshot({ stripe: true }).stripe).toEqual(expect.objectContaining({
      enabled: true,
      status: 'error',
      calls: 2,
      errors: 1,
      last_error_code: 'provider_timeout',
      last_success_at: expect.any(String),
      last_error_at: expect.any(String),
    }));
  });
});
