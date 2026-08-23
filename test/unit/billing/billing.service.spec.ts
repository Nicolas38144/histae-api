import type Stripe from 'stripe';
import { BillingService } from '../../../src/billing/billing.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = 'cus_HistaeCustomer';
const SUBSCRIPTION_ID = 'sub_HistaeSubscription';
const MONTHLY_PRICE_ID = 'price_histaeMonthly';
const noOpDelivery = {
  subscriptionUpdated: jest.fn().mockResolvedValue(undefined),
  billingPaymentFailed: jest.fn().mockResolvedValue(undefined),
  subscriptionTrialEnding: jest.fn().mockResolvedValue(undefined),
};

describe('BillingService', () => {
  const config = { billing: {
    provider: 'stripe',
    stripeSecretKey: 'sk_test_histaeSecret',
    premiumProductId: 'prod_histaePremium',
    premiumMonthlyPriceId: MONTHLY_PRICE_ID,
    premiumAnnualPriceId: 'price_histaeAnnual',
  } };

  it('creates one hosted mobile Checkout with the server-side Price and first trial', async () => {
    const repository = {
      beginCheckout: jest.fn().mockResolvedValue({
        state: 'created', attemptId: '22222222-2222-4222-8222-222222222222',
        stripeCustomerId: CUSTOMER_ID, trialDays: 30, trialUsed: false,
      }),
      markCheckoutOpen: jest.fn().mockResolvedValue(true),
      markCheckoutFailed: jest.fn(),
    };
    const stripe = {
      createCheckoutSession: jest.fn().mockResolvedValue({
        id: 'cs_test_HistaeSession', url: 'https://checkout.stripe.test/session', expires_at: 1_900_000_000,
      }),
    };
    const service = new BillingService(repository as never, stripe as never, config as never, noOpDelivery as never);

    await expect(service.createCheckout(USER_ID, 'monthly', '33333333-3333-4333-8333-333333333333')).resolves.toEqual({
      session_id: 'cs_test_HistaeSession',
      url: 'https://checkout.stripe.test/session',
      expires_at: new Date(1_900_000_000_000),
    });
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER_ID,
      customerId: CUSTOMER_ID,
      priceId: MONTHLY_PRICE_ID,
      billingPeriod: 'monthly',
      trialDays: 30,
      idempotencyKey: 'histae-checkout-22222222-2222-4222-8222-222222222222',
    }));
    expect(repository.markCheckoutOpen).toHaveBeenCalledTimes(1);
  });

  it('replays a persisted Checkout without making a second Stripe request', async () => {
    const session = {
      session_id: 'cs_test_HistaeSession',
      url: 'https://checkout.stripe.test/session',
      expires_at: new Date('2030-01-01T00:00:00.000Z'),
    };
    const repository = { beginCheckout: jest.fn().mockResolvedValue({ state: 'replay', session }) };
    const stripe = { createCheckoutSession: jest.fn() };
    const service = new BillingService(repository as never, stripe as never, config as never, noOpDelivery as never);

    await expect(service.createCheckout(USER_ID, 'monthly', '33333333-3333-4333-8333-333333333333')).resolves.toBe(session);
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('deletes a newly created Stripe Customer when the local account mapping fails', async () => {
    const attemptId = '22222222-2222-4222-8222-222222222222';
    const repository = {
      beginCheckout: jest.fn().mockResolvedValue({
        state: 'created', attemptId, stripeCustomerId: null, trialDays: 30, trialUsed: false,
      }),
      saveCustomer: jest.fn().mockResolvedValue(false),
      markCheckoutFailed: jest.fn().mockResolvedValue(undefined),
    };
    const stripe = {
      createCustomer: jest.fn().mockResolvedValue({ id: CUSTOMER_ID }),
      deleteCustomer: jest.fn().mockResolvedValue({ id: CUSTOMER_ID, deleted: true }),
    };
    const service = new BillingService(repository as never, stripe as never, config as never, noOpDelivery as never);

    await expect(service.createCheckout(USER_ID, 'monthly', '33333333-3333-4333-8333-333333333333'))
      .rejects.toEqual(expect.objectContaining({ status: 409, code: 'billing_customer_conflict' }));

    expect(stripe.deleteCustomer).toHaveBeenCalledWith(CUSTOMER_ID, `histae-delete-orphan-${attemptId}`);
  });

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
    const service = new BillingService(repository as never, stripe as never, config as never, delivery as never);

    await service.handleStripeWebhook(Buffer.from('{}'), 'signed-header');

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
    const service = new BillingService(repository as never, stripe as never, config as never, delivery as never);

    await service.handleStripeWebhook(Buffer.from('{}'), 'signed-header');

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
    const service = new BillingService(repository as never, stripe as never, config as never, noOpDelivery as never);

    await service.handleStripeWebhook(Buffer.from('{}'), 'signed-header');

    expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
    expect(repository.processWebhook).not.toHaveBeenCalled();
  });

  it('rejects unsigned webhook bodies before any database write', async () => {
    const repository = { processWebhook: jest.fn() };
    const service = new BillingService(repository as never, {} as never, config as never, noOpDelivery as never);

    await expect(service.handleStripeWebhook(Buffer.from('{}'), undefined)).rejects.toEqual(expect.objectContaining({
      status: 400,
      code: 'invalid_stripe_signature',
    }));
    expect(repository.processWebhook).not.toHaveBeenCalled();
  });

  it('deletes the Stripe customer as part of account erasure', async () => {
    const repository = { customerForUser: jest.fn().mockResolvedValue(CUSTOMER_ID) };
    const stripe = { deleteCustomer: jest.fn().mockResolvedValue({ id: CUSTOMER_ID, deleted: true }) };
    const service = new BillingService(repository as never, stripe as never, config as never, noOpDelivery as never);

    await service.deleteCustomerForAccount(USER_ID);

    expect(stripe.deleteCustomer).toHaveBeenCalledWith(CUSTOMER_ID, `histae-delete-customer-${USER_ID}`);
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
