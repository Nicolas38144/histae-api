import { randomUUID } from 'node:crypto';

import { BillingRepository } from '../../src/billing/billing.repository';
import { BillingReconciliationRepository } from '../../src/billing/billing-reconciliation.repository';
import { IsolatedPostgres } from '../helpers/isolated-postgres';

jest.setTimeout(30_000);

describe('PostgreSQL Stripe reconciliation', () => {
  let fixture: IsolatedPostgres;

  beforeEach(async () => {
    fixture = new IsolatedPostgres();
    await fixture.start();
  });

  afterEach(async () => fixture.stop());

  it('schedules due accounts and refuses to overwrite a newer projection', async () => {
    const userId = await fixture.account();
    const compact = userId.replaceAll('-', '');
    const customerId = `cus_${compact}`;
    const repository = new BillingReconciliationRepository(fixture.database);
    await fixture.pool.query(`
      INSERT INTO billing_customer (user_id, stripe_customer_id, stripe_reconciliation_due_at)
      VALUES ($1, $2, clock_timestamp() - interval '1 minute')
    `, [userId, customerId]);

    expect(await repository.scheduleDue(new Date(), 25)).toBe(1);
    const queued = await fixture.pool.query(`
      SELECT event_type, aggregate_id, status, payload
      FROM outbox_event WHERE aggregate_id = $1
    `, [userId]);
    expect(queued.rows).toEqual([{
      event_type: 'billing.subscription.reconcile',
      aggregate_id: userId,
      status: 'pending',
      payload: {},
    }]);
    expect(await repository.list('all', 25)).toEqual([]);
    await fixture.pool.query(`
      UPDATE outbox_event
      SET status = 'dead_letter', attempts = 10,
        last_error_code = 'billing_provider_unavailable',
        dead_lettered_at = clock_timestamp()
      WHERE aggregate_id = $1
    `, [userId]);
    expect(await repository.list('subscription', 25)).toEqual([
      expect.objectContaining({
        user_id: userId,
        kind: 'subscription',
        attempts: 10,
        last_error_code: 'billing_provider_unavailable',
      }),
    ]);

    const context = await repository.subscriptionContext(userId);
    expect(context).toEqual({ userId, stripeCustomerId: customerId, projectionVersion: null });
    const snapshotAt = new Date('2030-01-01T00:00:00.000Z');
    const projection = {
      userId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: `sub_${compact}`,
      stripePriceId: `price_${compact}`,
      billingPeriod: 'monthly' as const,
      status: 'active' as const,
      cancelAtPeriodEnd: false,
      currentPeriodStartsAt: snapshotAt,
      currentPeriodEndsAt: new Date('2030-02-01T00:00:00.000Z'),
      trialStartsAt: null,
      trialEndsAt: null,
      canceledAt: null,
      eventCreatedAt: snapshotAt,
    };
    await expect(repository.applySubscription(
      context!, projection, snapshotAt, new Date('2030-01-01T01:00:00.000Z'),
    )).resolves.toMatchObject({ state: 'applied', status: 'active' });

    const staleContext = await repository.subscriptionContext(userId);
    await fixture.pool.query(`
      UPDATE user_subscription
      SET status = 'past_due', projection_version = projection_version + 1,
        provider_snapshot_at = '2030-01-01T00:30:00.000Z'
      WHERE user_id = $1
    `, [userId]);
    await expect(repository.applySubscription(
      staleContext!, { ...projection, status: 'canceled' },
      new Date('2030-01-01T00:15:00.000Z'),
      new Date('2030-01-01T01:15:00.000Z'),
    )).resolves.toMatchObject({ state: 'stale', status: 'past_due' });
    expect((await fixture.pool.query(
      'SELECT status, projection_version::int FROM user_subscription WHERE user_id = $1', [userId],
    )).rows[0]).toEqual({ status: 'past_due', projection_version: 2 });
  });

  it('persists a 23-hour watchdog and safely clears an absent Customer intent', async () => {
    const userId = await fixture.account();
    const attemptId = randomUUID();
    await fixture.pool.query(`
      INSERT INTO billing_checkout_session (
        id, user_id, idempotency_key, billing_period, status, expires_at,
        customer_creation_started_at
      ) VALUES ($1, $2, $3, 'monthly', 'failed', clock_timestamp(),
        clock_timestamp() - interval '24 hours')
    `, [attemptId, userId, randomUUID()]);
    const repository = new BillingReconciliationRepository(fixture.database);

    expect(await repository.scheduleDue(new Date(), 25)).toBe(1);
    expect(await repository.customerCreationContext(attemptId)).toEqual(expect.objectContaining({
      attemptId, userId, createdCustomerId: null,
    }));
    await expect(repository.recoverCustomerCreation(attemptId, null)).resolves.toBe('cleared');
    expect((await fixture.pool.query(`
      SELECT customer_creation_started_at, created_customer_id, status
      FROM billing_checkout_session WHERE id = $1
    `, [attemptId])).rows[0]).toEqual({
      customer_creation_started_at: null,
      created_customer_id: null,
      status: 'failed',
    });
  });

  it('blocks a different Checkout key while a Customer creation remains uncertain', async () => {
    const userId = await fixture.account();
    const previousAttemptId = randomUUID();
    await fixture.pool.query(`
      INSERT INTO billing_checkout_session (
        id, user_id, idempotency_key, billing_period, status, expires_at,
        customer_creation_started_at
      ) VALUES ($1, $2, $3, 'monthly', 'failed', clock_timestamp(), clock_timestamp())
    `, [previousAttemptId, userId, randomUUID()]);
    const repository = new BillingRepository(fixture.database);
    const now = new Date();

    await expect(repository.beginCheckout(
      userId,
      randomUUID(),
      'monthly',
      randomUUID(),
      now,
      new Date(now.getTime() + 30 * 60_000),
      new Date(now.getTime() - 60_000),
    )).resolves.toEqual({ state: 'customer_reconciliation_required' });
    expect((await fixture.pool.query(
      'SELECT count(*)::int AS count FROM billing_checkout_session WHERE user_id = $1',
      [userId],
    )).rows[0]).toEqual({ count: 1 });
  });

  it('repairs the crash gap between persisting and attaching a created Customer', async () => {
    const userId = await fixture.account();
    const attemptId = randomUUID();
    const customerId = `cus_${userId.replaceAll('-', '')}`;
    await fixture.pool.query(`
      INSERT INTO billing_checkout_session (
        id, user_id, idempotency_key, billing_period, status, expires_at,
        customer_creation_started_at, created_customer_id
      ) VALUES ($1, $2, $3, 'monthly', 'failed', clock_timestamp(),
        clock_timestamp(), $4)
    `, [attemptId, userId, randomUUID(), customerId]);
    const repository = new BillingReconciliationRepository(fixture.database);
    const billing = new BillingRepository(fixture.database);
    const now = new Date();

    await expect(billing.beginCheckout(
      userId,
      randomUUID(),
      'monthly',
      randomUUID(),
      now,
      new Date(now.getTime() + 30 * 60_000),
      new Date(now.getTime() - 60_000),
    )).resolves.toEqual({ state: 'customer_reconciliation_required' });
    expect(await repository.scheduleDue(new Date(), 25)).toBe(1);
    expect(await repository.customerCreationContext(attemptId)).toEqual(expect.objectContaining({
      attemptId,
      createdCustomerId: customerId,
      mappedCustomerId: null,
    }));
    await expect(repository.recoverCustomerCreation(attemptId, customerId)).resolves.toBe('recovered');
    expect((await fixture.pool.query(`
      SELECT stripe_customer_id FROM billing_customer WHERE user_id = $1
    `, [userId])).rows).toEqual([{ stripe_customer_id: customerId }]);
  });

  it('removes the watchdog only when Customer attachment commits', async () => {
    const userId = await fixture.account();
    const attemptId = randomUUID();
    const customerId = `cus_${userId.replaceAll('-', '')}`;
    await fixture.pool.query(`
      INSERT INTO billing_checkout_session (
        id, user_id, idempotency_key, billing_period, status, expires_at
      ) VALUES ($1, $2, $3, 'monthly', 'creating', clock_timestamp())
    `, [attemptId, userId, randomUUID()]);
    const repository = new BillingRepository(fixture.database);

    await repository.beginCustomerCreation(attemptId);
    await repository.recordCreatedCustomer(attemptId, customerId);
    expect((await fixture.pool.query(`
      SELECT status, available_at <= clock_timestamp() AS due FROM outbox_event
      WHERE event_type = 'billing.customer.reconcile' AND aggregate_id = $1
    `, [attemptId])).rows).toEqual([{ status: 'pending', due: true }]);
    await expect(repository.saveCustomer(userId, customerId)).resolves.toBe(true);
    expect((await fixture.pool.query(`
      SELECT 1 FROM outbox_event
      WHERE event_type = 'billing.customer.reconcile' AND aggregate_id = $1
    `, [attemptId])).rowCount).toBe(0);
  });
});
