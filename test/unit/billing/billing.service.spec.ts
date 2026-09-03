import { BillingService } from '../../../src/billing/billing.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = 'cus_HistaeCustomer';
const MONTHLY_PRICE_ID = 'price_histaeMonthly';

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
    const service = new BillingService(repository as never, stripe as never, config as never);

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
    const service = new BillingService(repository as never, stripe as never, config as never);

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
    const service = new BillingService(repository as never, stripe as never, config as never);

    await expect(service.createCheckout(USER_ID, 'monthly', '33333333-3333-4333-8333-333333333333'))
      .rejects.toEqual(expect.objectContaining({ status: 409, code: 'billing_customer_conflict' }));

    expect(stripe.deleteCustomer).toHaveBeenCalledWith(CUSTOMER_ID, `histae-delete-orphan-${attemptId}`);
  });

  it('deletes the Stripe customer as part of account erasure', async () => {
    const repository = { customerForUser: jest.fn().mockResolvedValue(CUSTOMER_ID) };
    const stripe = { deleteCustomer: jest.fn().mockResolvedValue({ id: CUSTOMER_ID, deleted: true }) };
    const service = new BillingService(repository as never, stripe as never, config as never);

    await service.deleteCustomerForAccount(USER_ID);

    expect(stripe.deleteCustomer).toHaveBeenCalledWith(CUSTOMER_ID, `histae-delete-customer-${USER_ID}`);
  });
});
