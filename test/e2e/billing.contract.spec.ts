import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { JwtActiveGuard } from '../../src/auth/auth.guard';
import type { AuthenticatedRequest } from '../../src/auth/auth.types';
import { BillingController, StripeWebhookController } from '../../src/billing/billing.controller';
import { BillingService } from '../../src/billing/billing.service';
import { StripeWebhookService } from '../../src/billing/stripe-webhook.service';
import { ApiExceptionFilter } from '../../src/common/api-exception.filter';
import { ConfigService } from '../../src/config/config.service';
import { RateLimitService } from '../../src/ratelimit/rate-limit.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const IDEMPOTENCY_KEY = '22222222-2222-4222-8222-222222222222';

describe('Billing HTTP contract', () => {
  let app: NestFastifyApplication;
  const session = {
    session_id: 'cs_test_HistaeSession',
    url: 'https://checkout.stripe.test/session',
    expires_at: new Date('2030-01-01T00:00:00.000Z'),
  };
  const billing = {
    subscription: jest.fn().mockResolvedValue({ plan: 'free', access_granted: false }),
    createCheckout: jest.fn().mockResolvedValue(session),
    createPortal: jest.fn().mockResolvedValue({ url: 'https://billing.stripe.test/portal' }),
  };
  const webhooks = { handle: jest.fn().mockResolvedValue(undefined) };
  const limits = { enforce: jest.fn().mockResolvedValue(undefined) };
  const activeGuard: CanActivate = {
    canActivate(context: ExecutionContext): boolean {
      const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
      request.auth = {
        userId: USER_ID,
        account: { user_id: USER_ID, role: 'user', is_banned: false, onboarding_complete: true },
      };
      return true;
    },
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [BillingController, StripeWebhookController],
      providers: [
        { provide: BillingService, useValue: billing },
        { provide: StripeWebhookService, useValue: webhooks },
        { provide: RateLimitService, useValue: limits },
        { provide: ConfigService, useValue: { rateLimit: {
          billing: { max: 10, windowMs: 60_000 },
          billingWebhook: { max: 300, windowMs: 60_000 },
        } } },
      ],
    }).overrideGuard(JwtActiveGuard).useValue(activeGuard).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { rawBody: true });
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
  });

  afterAll(async () => app?.close());

  beforeEach(() => jest.clearAllMocks());

  it('returns the subscription projection for the authenticated account', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET', url: '/api/users/me/subscription',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ plan: 'free', access_granted: false });
    expect(billing.subscription).toHaveBeenCalledWith(USER_ID);
  });

  it('creates Checkout from the authenticated account, billing period, and idempotency header only', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/api/users/me/subscription/checkout',
      headers: { 'idempotency-key': IDEMPOTENCY_KEY },
      payload: { billing_period: 'annual' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ ...session, expires_at: '2030-01-01T00:00:00.000Z' });
    expect(billing.createCheckout).toHaveBeenCalledWith(USER_ID, 'annual', IDEMPOTENCY_KEY);
  });

  it('rejects client-supplied Stripe identifiers', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/api/users/me/subscription/checkout',
      headers: { 'idempotency-key': IDEMPOTENCY_KEY },
      payload: { billing_period: 'monthly', price_id: 'price_attackerControlled' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_checkout_payload');
    expect(billing.createCheckout).not.toHaveBeenCalled();
  });

  it('creates the Stripe customer portal under the billing rate limit', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST', url: '/api/users/me/subscription/portal',
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ url: 'https://billing.stripe.test/portal' });
    expect(limits.enforce).toHaveBeenCalledWith(
      'billing', USER_ID, { max: 10, windowMs: 60_000 }, 'billing_rate_limit_exceeded',
    );
    expect(billing.createPortal).toHaveBeenCalledWith(USER_ID);
  });

  it('passes Stripe the unmodified raw JSON bytes and signature header', async () => {
    const payload = '{"id":"evt_HistaeWebhook", "type":"checkout.session.completed"}';
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/api/billing/stripe/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=signed' },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });
    expect(limits.enforce).toHaveBeenCalledWith(
      'billing-webhook',
      '127.0.0.1',
      { max: 300, windowMs: 60_000 },
      'billing_webhook_rate_limit_exceeded',
    );
    expect(webhooks.handle).toHaveBeenCalledWith(Buffer.from(payload), 't=1,v1=signed');
  });
});
