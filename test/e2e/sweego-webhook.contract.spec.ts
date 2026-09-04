import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { SweegoWebhookController } from '../../src/auth/sweego-webhook.controller';
import { SweegoWebhookService } from '../../src/auth/sweego-webhook.service';
import { SweegoWebhookMetricsService } from '../../src/auth/sweego-webhook-metrics.service';
import { OtpRepository } from '../../src/auth/otp.repository';
import { ConfigService } from '../../src/config/config.service';
import { RateLimitService } from '../../src/ratelimit/rate-limit.service';
import { ApiExceptionFilter } from '../../src/common/api-exception.filter';
import { apiError } from '../../src/common/api-error';
import { registerHttpLifecycle } from '../../src/common/http/http-lifecycle';
import { smsEvent, signSmsBody, sweegoSecret } from '../helpers/sweego-fixtures';

describe('Sweego webhook HTTP contract', () => {
  let app: NestFastifyApplication;
  const repository = { applySmsEvent: jest.fn() };
  const limits = { enforce: jest.fn() };
  const config = { env: 'test', sms: { provider: 'sweego', senderId: 'Histae', webhookSecret: sweegoSecret },
    rateLimit: { global: { max: 100, windowMs: 60_000 }, smsWebhook: { max: 300, windowMs: 60_000 } } };
  const logger = { error: jest.fn(), warn: jest.fn() };
  let errorLog: jest.SpyInstance;
  beforeAll(async () => {
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const module = await Test.createTestingModule({ controllers: [SweegoWebhookController], providers: [
      SweegoWebhookService, SweegoWebhookMetricsService,
      { provide: ConfigService, useValue: config }, { provide: RateLimitService, useValue: limits },
      { provide: OtpRepository, useValue: repository },
    ] }).compile();
    const adapter = new FastifyAdapter({ bodyLimit: 1_048_576, logger: false });
    registerHttpLifecycle(adapter.getInstance(), limits as never, config as never, undefined, logger as never);
    app = module.createNestApplication<NestFastifyApplication>(adapter, { rawBody: true, logger: false });
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
  });
  beforeEach(() => { jest.clearAllMocks(); repository.applySmsEvent.mockReset().mockResolvedValue('applied');
    limits.enforce.mockReset().mockResolvedValue(undefined); });
  afterAll(async () => { await app?.close(); errorLog?.mockRestore(); });

  function request(event: unknown = smsEvent(), signed = true) {
    const body = Buffer.from(JSON.stringify(event, null, 2)), headers = signSmsBody(body);
    return app.inject({ method: 'POST', url: '/api/auth/sweego/webhook', payload: body,
      headers: { 'content-type': 'application/json', ...(signed ? {
        'webhook-id': String(headers.id), 'webhook-timestamp': String(headers.timestamp), 'webhook-signature': String(headers.signature),
      } : {}) } });
  }
  it('accepts a signed provider DTO without a mobile/admin session, preserves bytes and sets defensive headers', async () => {
    const response = await request();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(repository.applySmsEvent).toHaveBeenCalledTimes(1);
    expect(limits.enforce).toHaveBeenCalledTimes(1);
    expect(limits.enforce).toHaveBeenCalledWith('sms-webhook', expect.any(String), config.rateLimit.smsWebhook, 'sms_webhook_rate_limit_exceeded');
  });
  it('rejects unsigned requests and unknown supported-event fields before touching the database', async () => {
    expect((await request(smsEvent(), false)).statusCode).toBe(401);
    const bad = await request(smsEvent({ injected: true }));
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: { code: 'invalid_sweego_event', message: 'The SMS event is invalid.' } });
    expect(repository.applySmsEvent).not.toHaveBeenCalled();
  });
  it.each([{ event_type: 'sms_clicked' }, { test_mode: true }])('acknowledges out-of-scope signed events: %p', async override => {
    expect((await request(smsEvent(override))).statusCode).toBe(200);
    expect(repository.applySmsEvent).not.toHaveBeenCalled();
  });
  it('returns the dedicated 429 and fails closed when rate-limit protection fails', async () => {
    limits.enforce.mockRejectedValueOnce(apiError(429, 'sms_webhook_rate_limit_exceeded', 'Too many requests.'));
    expect((await request()).statusCode).toBe(429);
    limits.enforce.mockRejectedValueOnce(apiError(503, 'rate_limit_unavailable', 'Protection unavailable.'));
    expect((await request()).statusCode).toBe(503);
    expect(repository.applySmsEvent).not.toHaveBeenCalled();
  });
  it('bounds the signed payload and does not leak provider or database content through responses/logs', async () => {
    const oversized = await request(smsEvent({ details: 'x'.repeat(16_384) }));
    expect(oversized.statusCode).toBe(401);
    repository.applySmsEvent.mockRejectedValueOnce(new Error('SECRET_PRIVATE_DATABASE_DETAIL'));
    const response = await request(smsEvent({ phone_number: '0033600000000', details: 'SECRET_PRIVATE_PROVIDER_DETAIL' }));
    expect(response.statusCode).toBe(503);
    expect(response.json()).toHaveProperty('error.code', 'sweego_webhook_unavailable');
    const outputs = JSON.stringify([response.body, logger.error.mock.calls, logger.warn.mock.calls, errorLog.mock.calls]);
    expect(outputs).not.toMatch(/SECRET_PRIVATE|0033600000000|webhook-signature/);
  });
});
