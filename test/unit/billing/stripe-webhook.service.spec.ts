import type Stripe from 'stripe';
import { StripeWebhookService } from '../../../src/billing/stripe-webhook.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = 'cus_HistaeCustomer';
const MONTHLY_PRICE_ID = 'price_histaeMonthly';
const SUBSCRIPTION_ID = 'sub_HistaeSubscription';
const noOpDelivery = {
  subscriptionUpdated: jest.fn().mockResolvedValue(undefined),
  billingPaymentFailed: jest.fn().mockResolvedValue(undefined),
  subscriptionTrialEnding: jest.fn().mockResolvedValue(undefined),
};

describe('StripeWebhookService', () => {
  const config = { billing: {
    provider: 'stripe',
    stripeSecretKey: 'sk_test_histaeSecret',
    premiumProductId: 'prod_histaePremium',
    premiumMonthlyPriceId: MONTHLY_PRICE_ID,
    premiumAnnualPriceId: 'price_histaeAnnual',
  } };

  it('projects a verified subscription webhook and emits the mobile refresh event once', async () => {
    const subscription = stripeSubscription();
    const event = stripeEvent('customer.subscription.updated', subscription);
    const database = { query: jest.fn() };
    const repository = {
      webhookProcessed: jest.fn().mockResolvedValue(false),
      processWebhook: jest.fn(async (_metadata: unknown, work: (db: unknown) => Promise<unknown>) => ({
        duplicate: false,
        result: await work(database),
      })),
      resolveBillingUser: jest.fn().mockResolvedValue(USER_ID),
      upsertSubscription: jest.fn().mockResolvedValue(undefined),
    };
    const stripe = { constructWebhookEvent: jest.fn().mockReturnValue(event) };
    const delivery = { subscriptionUpdated: jest.fn().mockResolvedValue(undefined) };
    const service = new StripeWebhookService(repository as never, stripe as never, config as never, delivery as never);

    await service.handle(Buffer.from('{}'), 'signed-header');

    expect(stripe.constructWebhookEvent).toHaveBeenCalledWith(Buffer.from('{}'), 'signed-header');
    expect(repository.resolveBillingUser).toHaveBeenCalledWith(CUSTOMER_ID, USER_ID, database);
    expect(repository.upsertSubscription).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER_ID,
      stripeSubscriptionId: SUBSCRIPTION_ID,
      stripePriceId: MONTHLY_PRICE_ID,
      billingPeriod: 'monthly',
      status: 'active',
      currentPeriodStartsAt: new Date(1_899_000_000_000),
      currentPeriodEndsAt: new Date(1_900_000_000_000),
      eventCreatedAt: new Date(1_899_000_000_000),
    }), database);
    expect(delivery.subscriptionUpdated).toHaveBeenCalledWith(USER_ID, 'active');
  });

  it('retrieves the current subscription for invoice failures, records the invoice, and notifies the user', async () => {
    const subscription = stripeSubscription({ status: 'past_due' });
    const invoice = stripeInvoice();
    const event = stripeEvent('invoice.payment_failed', invoice);
    const database = { query: jest.fn() };
    const repository = {
      webhookProcessed: jest.fn().mockResolvedValue(false),
      processWebhook: jest.fn(async (_metadata: unknown, work: (db: unknown) => Promise<unknown>) => ({
        duplicate: false,
        result: await work(database),
      })),
      resolveBillingUser: jest.fn().mockResolvedValue(USER_ID),
      upsertSubscription: jest.fn().mockResolvedValue(undefined),
      upsertInvoice: jest.fn().mockResolvedValue(undefined),
    };
    const stripe = {
      constructWebhookEvent: jest.fn().mockReturnValue(event),
      retrieveSubscription: jest.fn().mockResolvedValue(subscription),
    };
    const delivery = {
      subscriptionUpdated: jest.fn().mockResolvedValue(undefined),
      billingPaymentFailed: jest.fn().mockResolvedValue(undefined),
    };
    const service = new StripeWebhookService(repository as never, stripe as never, config as never, delivery as never);

    await service.handle(Buffer.from('{}'), 'signed-header');

    expect(stripe.retrieveSubscription).toHaveBeenCalledWith(SUBSCRIPTION_ID);
    expect(repository.upsertInvoice).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      stripeInvoiceId: 'in_HistaeInvoice',
      stripeSubscriptionId: SUBSCRIPTION_ID,
      status: 'open',
      currency: 'EUR',
      amountDue: 500,
    }), database);
    expect(delivery.billingPaymentFailed).toHaveBeenCalledWith(USER_ID);
  });

  it('short-circuits an already processed webhook before another Stripe API request', async () => {
    const event = stripeEvent('invoice.payment_failed', stripeInvoice());
    const repository = {
      webhookProcessed: jest.fn().mockResolvedValue(true),
      processWebhook: jest.fn(),
    };
    const stripe = {
      constructWebhookEvent: jest.fn().mockReturnValue(event),
      retrieveSubscription: jest.fn(),
    };
    const service = new StripeWebhookService(repository as never, stripe as never, config as never, noOpDelivery as never);

    await service.handle(Buffer.from('{}'), 'signed-header');

    expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
    expect(repository.processWebhook).not.toHaveBeenCalled();
  });

  it('rejects unsigned webhook bodies before any database write', async () => {
    const repository = { processWebhook: jest.fn() };
    const service = new StripeWebhookService(repository as never, {} as never, config as never, noOpDelivery as never);

    await expect(service.handle(Buffer.from('{}'), undefined)).rejects.toEqual(expect.objectContaining({
      status: 400,
      code: 'invalid_stripe_signature',
    }));
    expect(repository.processWebhook).not.toHaveBeenCalled();
  });

  it('ignores unsupported events and rejects a mode mismatch before database work', async () => {
    const repository = { webhookProcessed: jest.fn(), processWebhook: jest.fn() };
    const stripe = { constructWebhookEvent: jest.fn().mockReturnValue(stripeEvent('balance.available', {})) };
    const service = new StripeWebhookService(repository as never, stripe as never, config as never, noOpDelivery as never);
    await expect(service.handle(Buffer.from('{}'), 'signed')).resolves.toBeUndefined();
    stripe.constructWebhookEvent.mockReturnValue({ ...stripeEvent('customer.subscription.updated', stripeSubscription()), livemode: true });
    await expect(service.handle(Buffer.from('{}'), 'signed')).rejects.toMatchObject({ code: 'stripe_mode_mismatch' });
    expect(repository.webhookProcessed).not.toHaveBeenCalled();
    expect(repository.processWebhook).not.toHaveBeenCalled();
  });

  it('fetches provider data before the transaction and delivers only after commit', async () => {
    const order: string[] = [];
    const database = {};
    const repository = {
      webhookProcessed: jest.fn().mockResolvedValue(false),
      processWebhook: jest.fn(async (_metadata: unknown, work: (db: unknown) => Promise<unknown>) => {
        order.push('begin');
        const result = await work(database);
        order.push('commit');
        return { duplicate: false, result };
      }),
      resolveBillingUser: jest.fn().mockResolvedValue(USER_ID),
      upsertSubscription: jest.fn(async () => { order.push('subscription'); }),
      upsertInvoice: jest.fn(async () => { order.push('invoice'); }),
    };
    const stripe = {
      constructWebhookEvent: jest.fn().mockReturnValue(stripeEvent('invoice.paid', stripeInvoice())),
      retrieveSubscription: jest.fn(async () => { order.push('fetch'); return stripeSubscription(); }),
    };
    const delivery = { subscriptionUpdated: jest.fn(async () => { order.push('notify'); }) };
    await new StripeWebhookService(repository as never, stripe as never, config as never, delivery as never).handle(Buffer.from('{}'), 'signed');
    expect(order).toEqual(['fetch', 'begin', 'subscription', 'invoice', 'commit', 'notify']);
  });

  it('does not deliver an effect if the webhook transaction rolls back', async () => {
    const failure = new Error('transaction aborted');
    const repository = {
      webhookProcessed: jest.fn().mockResolvedValue(false),
      processWebhook: jest.fn().mockRejectedValue(failure),
    };
    const stripe = { constructWebhookEvent: jest.fn().mockReturnValue(stripeEvent('customer.subscription.updated', stripeSubscription())) };
    const delivery = { subscriptionUpdated: jest.fn() };
    const service = new StripeWebhookService(repository as never, stripe as never, config as never, delivery as never);
    await expect(service.handle(Buffer.from('{}'), 'signed')).rejects.toBe(failure);
    expect(delivery.subscriptionUpdated).not.toHaveBeenCalled();
  });

  it('does not deliver an effect from a concurrent duplicate webhook', async () => {
    const repository = {
      webhookProcessed: jest.fn().mockResolvedValue(false),
      processWebhook: jest.fn().mockResolvedValue({ duplicate: true, result: { userId: USER_ID, subscriptionStatus: 'active' } }),
    };
    const stripe = { constructWebhookEvent: jest.fn().mockReturnValue(stripeEvent('customer.subscription.updated', stripeSubscription())) };
    const delivery = { subscriptionUpdated: jest.fn() };
    await new StripeWebhookService(repository as never, stripe as never, config as never, delivery as never).handle(Buffer.from('{}'), 'signed');
    expect(delivery.subscriptionUpdated).not.toHaveBeenCalled();
  });
});

function stripeSubscription(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: SUBSCRIPTION_ID,
    object: 'subscription',
    customer: CUSTOMER_ID,
    status: 'active',
    metadata: { histae_user_id: USER_ID },
    cancel_at_period_end: false,
    canceled_at: null,
    trial_start: null,
    trial_end: null,
    items: { object: 'list', has_more: false, url: '/v1/subscription_items', data: [{
      id: 'si_HistaeItem',
      current_period_start: 1_899_000_000,
      current_period_end: 1_900_000_000,
      price: { id: MONTHLY_PRICE_ID, product: 'prod_histaePremium' },
    }] },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function stripeInvoice(): Stripe.Invoice {
  return {
    id: 'in_HistaeInvoice',
    object: 'invoice',
    customer: CUSTOMER_ID,
    parent: { type: 'subscription_details', subscription_details: { subscription: SUBSCRIPTION_ID, metadata: {} } },
    status: 'open',
    currency: 'eur',
    amount_due: 500,
    amount_paid: 0,
    amount_remaining: 500,
    period_start: 1_899_000_000,
    period_end: 1_900_000_000,
    status_transitions: { paid_at: null },
    created: 1_899_000_000,
  } as unknown as Stripe.Invoice;
}

function stripeEvent(type: string, object: object): Stripe.Event {
  return {
    id: 'evt_HistaeEvent',
    object: 'event',
    type,
    livemode: false,
    api_version: '2026-07-29.dahlia',
    created: 1_899_000_000,
    data: { object },
  } as unknown as Stripe.Event;
}
