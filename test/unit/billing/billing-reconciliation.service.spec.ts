import { BillingReconciliationService } from '../../../src/billing/billing-reconciliation.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_ID = 'cus_HistaeCustomer';

describe('BillingReconciliationService', () => {
  it('records bounded scheduling through the maintenance tracker', async () => {
    const { service, repository, tracker } = setup();
    repository.scheduleDue.mockResolvedValue(12);

    await expect(service.runOnce(new Date('2030-01-01T00:00:00.000Z'))).resolves.toBe(12);

    expect(tracker.track).toHaveBeenCalledWith('billing', expect.any(Function), expect.any(Function));
    expect(repository.scheduleDue).toHaveBeenCalledWith(
      new Date('2030-01-01T00:00:00.000Z'),
      25,
    );
  });

  it('repairs a subscription projection from an authoritative Stripe snapshot', async () => {
    const { service, repository, stripe, delivery } = setup();
    stripe.retrieveCustomer.mockResolvedValue({ id: CUSTOMER_ID, deleted: false });
    stripe.listCustomerSubscriptions.mockResolvedValue({ subscriptions: [subscription()], truncated: false });
    repository.applySubscription.mockResolvedValue({ state: 'applied', previousStatus: 'past_due', status: 'active' });

    await service.process('billing.subscription.reconcile', USER_ID);

    expect(repository.applySubscription).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, projectionVersion: 7 }),
      expect.objectContaining({ userId: USER_ID, stripeSubscriptionId: 'sub_HistaePremium', status: 'active' }),
      expect.any(Date),
      expect.any(Date),
      false,
    );
    expect(delivery.subscriptionUpdated).toHaveBeenCalledWith(USER_ID, 'active');
  });

  it('does not deliver a stale snapshot that lost an optimistic version race', async () => {
    const { service, repository, stripe, delivery } = setup();
    stripe.retrieveCustomer.mockResolvedValue({ id: CUSTOMER_ID, deleted: false });
    stripe.listCustomerSubscriptions.mockResolvedValue({ subscriptions: [subscription()], truncated: false });
    repository.applySubscription.mockResolvedValue({ state: 'stale', previousStatus: 'active', status: 'active' });

    await service.process('billing.subscription.reconcile', USER_ID);

    expect(delivery.subscriptionUpdated).not.toHaveBeenCalled();
  });

  it('dead-letters an ambiguous set of current Premium subscriptions', async () => {
    const { service, stripe, repository } = setup();
    stripe.retrieveCustomer.mockResolvedValue({ id: CUSTOMER_ID, deleted: false });
    stripe.listCustomerSubscriptions.mockResolvedValue({
      subscriptions: [subscription('sub_HistaeOne'), subscription('sub_HistaeTwo')],
      truncated: false,
    });

    await expect(service.process('billing.subscription.reconcile', USER_ID)).rejects.toEqual(
      expect.objectContaining({
        code: 'billing_multiple_current_subscriptions',
        permanent: true,
      }),
    );
    expect(repository.applySubscription).not.toHaveBeenCalled();
  });

  it('recovers a customer whose create response was lost without replaying the POST', async () => {
    const { service, repository, stripe } = setup();
    repository.customerCreationContext.mockResolvedValue({
      attemptId: ATTEMPT_ID,
      userId: USER_ID,
      startedAt: new Date(Date.now() - 24 * 60 * 60_000),
      createdCustomerId: null,
      mappedCustomerId: null,
      customerErasedAt: null,
    });
    stripe.searchCustomersByAttempt.mockResolvedValue({
      customers: [{ id: CUSTOMER_ID, metadata: {
        histae_user_id: USER_ID,
        histae_customer_attempt_id: ATTEMPT_ID,
      } }],
      truncated: false,
    });
    repository.recoverCustomerCreation.mockResolvedValue('recovered');

    await service.process('billing.customer.reconcile', ATTEMPT_ID);

    expect(repository.recoverCustomerCreation).toHaveBeenCalledWith(ATTEMPT_ID, CUSTOMER_ID);
    expect(stripe.listCustomersCreatedBetween).not.toHaveBeenCalled();
  });

  it('attaches a persisted Customer ID after a crash without searching or creating again', async () => {
    const { service, repository, stripe } = setup();
    repository.customerCreationContext.mockResolvedValue({
      attemptId: ATTEMPT_ID,
      userId: USER_ID,
      startedAt: new Date(),
      createdCustomerId: CUSTOMER_ID,
      mappedCustomerId: null,
      customerErasedAt: null,
    });
    repository.recoverCustomerCreation.mockResolvedValue('recovered');

    await service.process('billing.customer.reconcile', ATTEMPT_ID);

    expect(repository.recoverCustomerCreation).toHaveBeenCalledWith(ATTEMPT_ID, CUSTOMER_ID);
    expect(stripe.searchCustomersByAttempt).not.toHaveBeenCalled();
    expect(stripe.listCustomersCreatedBetween).not.toHaveBeenCalled();
  });

  it('clears a legacy uncertain intent only after both safe reads find no Customer', async () => {
    const { service, repository, stripe } = setup();
    repository.customerCreationContext.mockResolvedValue({
      attemptId: ATTEMPT_ID,
      userId: USER_ID,
      startedAt: new Date(Date.now() - 24 * 60 * 60_000),
      createdCustomerId: null,
      mappedCustomerId: null,
      customerErasedAt: null,
    });
    stripe.searchCustomersByAttempt.mockResolvedValue({ customers: [], truncated: false });
    stripe.listCustomersCreatedBetween.mockResolvedValue({ customers: [], truncated: false });
    repository.recoverCustomerCreation.mockResolvedValue('cleared');

    await service.process('billing.customer.reconcile', ATTEMPT_ID);

    expect(repository.recoverCustomerCreation).toHaveBeenCalledWith(ATTEMPT_ID, null);
  });
});

function setup() {
  const repository = {
    subscriptionContext: jest.fn().mockResolvedValue({
      userId: USER_ID,
      stripeCustomerId: CUSTOMER_ID,
      projectionVersion: 7,
    }),
    customerCreationContext: jest.fn(),
    applySubscription: jest.fn(),
    recoverCustomerCreation: jest.fn(),
    scheduleDue: jest.fn(),
    list: jest.fn(),
  };
  const stripe = {
    retrieveCustomer: jest.fn(),
    listCustomerSubscriptions: jest.fn(),
    searchCustomersByAttempt: jest.fn(),
    listCustomersCreatedBetween: jest.fn(),
  };
  const activity = {
    runExisting: jest.fn(async (_ids: string[], work: (assertHeld: () => void) => Promise<unknown>) => work(() => {})),
  };
  const tracker = {
    track: jest.fn(async (
      _name: string,
      work: () => Promise<unknown>,
    ) => work()),
  };
  const delivery = { subscriptionUpdated: jest.fn() };
  const config = {
    maintenanceMode: 'disabled',
    billing: {
      provider: 'stripe',
      premiumProductId: 'prod_HistaePremium',
      premiumMonthlyPriceId: 'price_HistaeMonthly',
      premiumAnnualPriceId: 'price_HistaeAnnual',
      reconciliationIntervalMillis: 300_000,
      reconciliationFreshnessMillis: 3_600_000,
      reconciliationBatchSize: 25,
    },
  };
  const service = new BillingReconciliationService(
    repository as never,
    stripe as never,
    config as never,
    activity as never,
    tracker as never,
    delivery as never,
  );
  return { service, repository, stripe, tracker, delivery };
}

function subscription(id = 'sub_HistaePremium') {
  return {
    id,
    customer: CUSTOMER_ID,
    status: 'active',
    created: 1_800_000_000,
    metadata: { histae_user_id: USER_ID },
    cancel_at_period_end: false,
    trial_start: null,
    trial_end: null,
    canceled_at: null,
    items: { data: [{
      price: { id: 'price_HistaeMonthly', product: 'prod_HistaePremium' },
      current_period_start: 1_800_000_000,
      current_period_end: 1_802_592_000,
    }] },
  } as never;
}
