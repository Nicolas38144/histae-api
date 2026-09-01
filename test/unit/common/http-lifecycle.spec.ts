import Fastify from 'fastify';
import { apiError } from '../../../src/common/api-error';
import { registerHttpLifecycle } from '../../../src/common/http/http-lifecycle';

describe('HTTP lifecycle security', () => {
  it('sets defensive headers and replaces an invalid request ID', async () => {
    const app = Fastify();
    registerHttpLifecycle(app, limits(), config());
    app.get('/api/check', async () => ({ ok: true }));

    const response = await app.inject({
      method: 'GET',
      url: '/api/check',
      headers: { 'x-request-id': 'not-a-valid-id' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers).toEqual(expect.objectContaining({
      'cache-control': 'no-store',
      'content-security-policy': "base-uri 'none'; frame-ancestors 'none'; object-src 'none'",
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'x-permitted-cross-domain-policies': 'none',
    }));
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    await app.close();
  });

  it('stops the request lifecycle when the global limit rejects it', async () => {
    const app = Fastify();
    const handler = jest.fn().mockResolvedValue({ should_not_run: true });
    registerHttpLifecycle(app, limits(jest.fn().mockRejectedValue(
      apiError(429, 'rate_limit_exceeded', 'Too many requests.', undefined, 12),
    )), config());
    app.get('/api/check', handler);

    const response = await app.inject({ method: 'GET', url: '/api/check' });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('12');
    expect(response.json()).toEqual({ error: { code: 'rate_limit_exceeded', message: 'Too many requests.' } });
    expect(handler).not.toHaveBeenCalled();
    await app.close();
  });

  it('leaves Stripe webhook requests to their signature and dedicated limiter', async () => {
    const app = Fastify();
    const enforce = jest.fn();
    registerHttpLifecycle(app, limits(enforce), config());
    app.post('/api/billing/stripe/webhook', async () => ({ received: true }));

    const response = await app.inject({ method: 'POST', url: '/api/billing/stripe/webhook' });

    expect(response.statusCode).toBe(200);
    expect(enforce).not.toHaveBeenCalled();
    await app.close();
  });
});

function limits(enforce = jest.fn().mockResolvedValue(undefined)): never {
  return { enforce } as never;
}

function config(): never {
  return { env: 'test', rateLimit: { global: { max: 100, windowMs: 60_000 } } } as never;
}
