import { request } from 'node:http';
import { MetricsServerService } from '../../../src/operations/metrics-server.service';

describe('MetricsServerService', () => {
  const token = 'metrics-token-that-is-at-least-32-bytes';
  let service: MetricsServerService;

  beforeEach(() => {
    service = new MetricsServerService(
      { metrics: { enabled: true, host: '127.0.0.1', port: 0, token } } as never,
      { render: jest.fn().mockResolvedValue('histae_test_metric 1\n') } as never,
    );
  });

  afterEach(async () => service.onModuleDestroy());

  it('serves only the authenticated GET metrics resource with defensive headers', async () => {
    const port = await service.start();
    expect(port).not.toBeNull();

    const unauthorized = await call(port!, '/metrics', 'GET');
    expect(unauthorized).toEqual(expect.objectContaining({ status: 401, body: 'Unauthorized\n' }));
    expect(unauthorized.headers).toEqual(expect.objectContaining({
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'www-authenticate': 'Bearer',
    }));

    await expect(call(port!, '/metrics', 'GET', `Bearer ${token}-wrong`)).resolves.toEqual(expect.objectContaining({ status: 401 }));
    await expect(call(port!, '/other', 'GET', `Bearer ${token}`)).resolves.toEqual(expect.objectContaining({ status: 404 }));
    await expect(call(port!, '/metrics', 'POST', `Bearer ${token}`)).resolves.toEqual(expect.objectContaining({ status: 405 }));

    const response = await call(port!, '/metrics', 'GET', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(response.body).toBe('histae_test_metric 1\n');
  });

  it('does not bind a listener when export is disabled', async () => {
    service = new MetricsServerService(
      { metrics: { enabled: false, host: '127.0.0.1', port: 0, token: '' } } as never,
      { render: jest.fn() } as never,
    );
    await expect(service.start()).resolves.toBeNull();
  });
});

function call(port: number, path: string, method: string, authorization?: string): Promise<{
  status: number | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const operation = request({ host: '127.0.0.1', port, path, method, headers: authorization ? { authorization } : {} }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    operation.on('error', reject);
    operation.end();
  });
}
