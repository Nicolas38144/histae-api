import { BillingService } from '../../../src/billing/billing.service';
import type { CustomerCreation } from '../../../src/billing/billing.repository';
import { accountActivityStub } from '../../account-activity.stub';

const USER = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333';

function setup(provider = 'stripe') {
  const creation: CustomerCreation = { id: ATTEMPT, user_id: USER, customer_creation_started_at: new Date(), created_customer_id: null, customer_erased_at: null };
  const repository = {
    beginCheckout: jest.fn().mockResolvedValue({ state: 'created', attemptId: ATTEMPT, stripeCustomerId: null, trialDays: 0, trialUsed: false }),
    beginCustomerCreation: jest.fn().mockResolvedValue(creation),
    recordCreatedCustomer: jest.fn(async (_id: string, customer: string) => { creation.created_customer_id = customer; }),
    markCreatedCustomerErased: jest.fn(async () => { creation.customer_erased_at = new Date(); }),
    markCheckoutFailed: jest.fn(),
    customerForUser: jest.fn().mockResolvedValue(undefined),
    customerCreationsForErasure: jest.fn().mockResolvedValue([creation]),
  };
  const stripe = {
    createCustomer: jest.fn().mockResolvedValue({ id: 'cus_Test' }),
    deleteCustomer: jest.fn().mockResolvedValue({ id: 'cus_Test', deleted: true }),
    retrieveCustomer: jest.fn().mockRejectedValue(new Error('unavailable')),
  };
  const service = new BillingService(repository as never, stripe as never, { billing: { provider } } as never, accountActivityStub);
  return { creation, repository, stripe, service };
}

describe('Stripe erasure recovery', () => {
  it('accepts an uncertain DELETE only after retrieving its matching deleted marker', async () => {
    const { creation, repository, stripe, service } = setup();
    creation.created_customer_id = 'cus_Known';
    stripe.deleteCustomer.mockRejectedValueOnce(new Error('response lost'));
    stripe.retrieveCustomer.mockResolvedValueOnce({ id: 'cus_Known', deleted: true });
    await expect(service.deleteCustomerForAccount(USER)).resolves.toBe(true);
    expect(repository.markCreatedCustomerErased).toHaveBeenCalledTimes(1);
  });

  it.each([{ id: 'cus_Known', deleted: false }, { id: 'cus_Other', deleted: true }])('refuses an unverified deletion marker %j', async (marker) => {
    const { creation, repository, stripe, service } = setup();
    creation.created_customer_id = 'cus_Known';
    stripe.deleteCustomer.mockRejectedValue(new Error('deletion failed'));
    stripe.retrieveCustomer.mockResolvedValue(marker);
    await expect(service.deleteCustomerForAccount(USER)).rejects.toMatchObject({ code: 'data_erasure_unavailable' });
    expect(repository.markCreatedCustomerErased).not.toHaveBeenCalled();
  });
  it('recovers a lost customer creation response using the original persisted intent and POST key', async () => {
    const { repository, stripe, service } = setup();
    stripe.createCustomer.mockRejectedValueOnce(new Error('response lost after creation'));
    await expect(service.createCheckout(USER, 'monthly', KEY)).rejects.toMatchObject({ code: 'stripe_request_failed' });
    expect(repository.beginCustomerCreation.mock.invocationCallOrder[0]).toBeLessThan(stripe.createCustomer.mock.invocationCallOrder[0]!);
    await expect(service.deleteCustomerForAccount(USER)).resolves.toBe(true);
    expect(stripe.createCustomer.mock.calls).toEqual([
      [USER, ATTEMPT, `histae-customer-${ATTEMPT}`],
      [USER, ATTEMPT, `histae-customer-${ATTEMPT}`],
    ]);
    expect(repository.recordCreatedCustomer).toHaveBeenCalledWith(ATTEMPT, 'cus_Test');
    expect(stripe.deleteCustomer).toHaveBeenCalledWith('cus_Test', `histae-delete-orphan-${ATTEMPT}`);
    expect(repository.markCreatedCustomerErased).toHaveBeenCalledTimes(1);
  });

  it('retries the same customer after a lost DELETE response, without recreating it', async () => {
    const { creation, repository, stripe, service } = setup();
    creation.created_customer_id = 'cus_Known';
    stripe.deleteCustomer.mockRejectedValueOnce(new Error('response lost'));
    await expect(service.deleteCustomerForAccount(USER)).rejects.toMatchObject({ code: 'data_erasure_unavailable' });
    expect(repository.markCreatedCustomerErased).not.toHaveBeenCalled();
    await expect(service.deleteCustomerForAccount(USER)).resolves.toBe(true);
    expect(stripe.deleteCustomer.mock.calls).toEqual([['cus_Known', `histae-delete-orphan-${ATTEMPT}`], ['cus_Known', `histae-delete-orphan-${ATTEMPT}`]]);
    expect(stripe.createCustomer).not.toHaveBeenCalled();
  });

  it('fails closed beyond the POST idempotency safety window when the customer is unknown', async () => {
    const { creation, stripe, service } = setup();
    creation.customer_creation_started_at = new Date(Date.now() - 24 * 60 * 60_000);
    await expect(service.deleteCustomerForAccount(USER)).rejects.toMatchObject({ code: 'erasure_stripe_reconciliation_required' });
    expect(stripe.createCustomer).not.toHaveBeenCalled();
    expect(stripe.deleteCustomer).not.toHaveBeenCalled();
  });

  it('can erase a known customer after the POST idempotency window has expired', async () => {
    const { creation, stripe, service } = setup();
    creation.customer_creation_started_at = new Date(0);
    creation.created_customer_id = 'cus_Known';
    await expect(service.deleteCustomerForAccount(USER)).resolves.toBe(true);
    expect(stripe.createCustomer).not.toHaveBeenCalled();
  });

  it('does not consider a disabled Stripe provider proof of successful erasure', async () => {
    const { service, stripe } = setup('disabled');
    await expect(service.deleteCustomerForAccount(USER)).rejects.toMatchObject({ code: 'billing_unavailable' });
    expect(stripe.createCustomer).not.toHaveBeenCalled();
  });

  it('does not require Stripe for an account with no customer and no creation intent', async () => {
    const { service, repository, stripe } = setup('disabled');
    repository.customerCreationsForErasure.mockResolvedValue([]);
    await expect(service.deleteCustomerForAccount(USER)).resolves.toBe(true);
    expect(stripe.deleteCustomer).not.toHaveBeenCalled();
  });

  it('bounds cleanup to one batch before moving to the photo stage', async () => {
    const { service, repository } = setup();
    repository.customerCreationsForErasure.mockResolvedValue(Array.from({ length: 50 }, (_, i) => ({
      id: String(i), customer_creation_started_at: new Date(), created_customer_id: `cus_Test${i}`, customer_erased_at: null,
    })));
    await expect(service.deleteCustomerForAccount(USER)).resolves.toBe(false);
    expect(repository.markCreatedCustomerErased).toHaveBeenCalledTimes(50);
  });
});
