import { Injectable } from '@nestjs/common';
import type { Queryable } from '../database/database.service';
import { DatabaseService } from '../database/database.service';
import type {
  BillingPeriod,
  CheckoutSessionView,
  InvoiceProjection,
  SubscriptionProjection,
  SubscriptionRow,
  WebhookMetadata,
} from './billing.models';
import { BillingAccountInactiveError, BillingMappingError } from './billing.errors';

type CheckoutAttemptRow = {
  id: string;
  billing_period: BillingPeriod;
  stripe_session_id: string | null;
  checkout_url: string | null;
  status: 'creating' | 'open' | 'completed' | 'expired' | 'failed';
  expires_at: Date;
  updated_at: Date;
};

type CheckoutContext = {
  attemptId: string;
  stripeCustomerId: string | null;
  trialDays: number;
  trialUsed: boolean;
};

export type BeginCheckoutResult =
  | ({ state: 'created' | 'retry' } & CheckoutContext)
  | { state: 'replay'; session: CheckoutSessionView }
  | { state: 'not_found' }
  | { state: 'already_subscribed' }
  | { state: 'in_progress' }
  | { state: 'customer_reconciliation_required' }
  | { state: 'idempotency_conflict' }
  | { state: 'idempotency_consumed' };

export { BillingAccountInactiveError, BillingMappingError } from './billing.errors';
export type CustomerCreation = {
  id: string;
  user_id: string;
  customer_creation_started_at: Date;
  created_customer_id: string | null;
  customer_erased_at: Date | null;
};

@Injectable()
export class BillingRepository {
  constructor(private readonly database: DatabaseService) {}

  async subscriptionForUser(userId: string): Promise<SubscriptionRow | undefined> {
    return (await this.database.query<SubscriptionRow>(`
      SELECT subscription.plan, subscription.provider, subscription.provider_subscription_id,
        subscription.provider_price_id, subscription.billing_period, subscription.status,
        subscription.cancel_at_period_end, subscription.current_period_starts_at,
        subscription.current_period_ends_at, subscription.trial_ends_at, subscription.canceled_at,
        subscription.updated_at, customer.stripe_customer_id,
        subscription.projection_version, subscription.provider_snapshot_at
      FROM user_subscription AS subscription
      LEFT JOIN billing_customer AS customer ON customer.user_id = subscription.user_id
      WHERE subscription.user_id = $1
    `, [userId])).rows[0];
  }

  async customerForUser(userId: string): Promise<string | undefined> {
    return (await this.database.query<{ stripe_customer_id: string }>(`
      SELECT stripe_customer_id FROM billing_customer
      WHERE user_id = $1 AND stripe_customer_deleted_at IS NULL
    `, [userId])).rows[0]?.stripe_customer_id;
  }

  async beginCheckout(
    userId: string,
    idempotencyKey: string,
    billingPeriod: BillingPeriod,
    attemptId: string,
    now: Date,
    expiresAt: Date,
    staleBefore: Date,
  ): Promise<BeginCheckoutResult> {
    return this.database.transaction(async (client) => {
      const account = await client.query<{ user_id: string }>(`
        SELECT user_id FROM user_account WHERE user_id = $1 AND deleted_at IS NULL FOR UPDATE
      `, [userId]);
      if (!account.rows[0]) return { state: 'not_found' };

      const previous = (await client.query<CheckoutAttemptRow>(`
        SELECT id, billing_period, stripe_session_id, checkout_url, status, expires_at, updated_at
        FROM billing_checkout_session WHERE user_id = $1 AND idempotency_key = $2
      `, [userId, idempotencyKey])).rows[0];
      if (previous) {
        if (previous.billing_period !== billingPeriod) return { state: 'idempotency_conflict' };
        if (previous.status === 'open' && previous.stripe_session_id && previous.checkout_url && previous.expires_at > now) {
          return { state: 'replay', session: {
            session_id: previous.stripe_session_id,
            url: previous.checkout_url,
            expires_at: previous.expires_at,
          } };
        }
        if (previous.status === 'completed' || previous.status === 'expired') return { state: 'idempotency_consumed' };
        if (previous.status === 'creating' && previous.updated_at > staleBefore) return { state: 'in_progress' };
      }

      await client.query(`
        UPDATE billing_checkout_session
        SET status = 'expired', checkout_url = NULL, updated_at = clock_timestamp()
        WHERE user_id = $1 AND status = 'open' AND expires_at <= $2
      `, [userId, now]);
      await client.query(`
        UPDATE billing_checkout_session SET status = 'failed', updated_at = clock_timestamp()
        WHERE user_id = $1 AND status = 'creating' AND updated_at <= $2
      `, [userId, staleBefore]);

      if (await this.hasActiveSubscription(userId, now, client)) return { state: 'already_subscribed' };
      const otherLive = await client.query(`
        SELECT 1 FROM billing_checkout_session
        WHERE user_id = $1 AND status IN ('creating', 'open')
        LIMIT 1
      `, [userId]);
      if (otherLive.rows[0]) return { state: 'in_progress' };

      // A new idempotency key must not start a second Customer POST while the
      // outcome of an earlier attempt is unknown. Retrying that earlier key is
      // safe because it reuses both the local attempt and Stripe key.
      const unresolvedCustomer = await client.query(`
        SELECT 1
        FROM billing_checkout_session AS checkout
        WHERE checkout.user_id = $1
          AND checkout.customer_creation_started_at IS NOT NULL
          AND checkout.customer_erased_at IS NULL
          AND ($2::uuid IS NULL OR checkout.id <> $2)
          AND NOT EXISTS (
            SELECT 1 FROM billing_customer AS customer
            WHERE customer.user_id = checkout.user_id
              AND customer.stripe_customer_deleted_at IS NULL
          )
        LIMIT 1
      `, [userId, previous?.id ?? null]);
      if (unresolvedCustomer.rows[0]) return { state: 'customer_reconciliation_required' };

      const context = await this.checkoutContext(userId, client);
      if (!context) throw new Error('active Premium subscription plan is missing');
      if (previous) {
        await client.query(`
          UPDATE billing_checkout_session
          SET status = 'creating', stripe_session_id = NULL, checkout_url = NULL,
            expires_at = $3, updated_at = clock_timestamp()
          WHERE user_id = $1 AND id = $2
        `, [userId, previous.id, expiresAt]);
        return { state: 'retry', attemptId: previous.id, ...context };
      }
      await client.query(`
        INSERT INTO billing_checkout_session
          (id, user_id, idempotency_key, billing_period, status, expires_at)
        VALUES ($1, $2, $3, $4, 'creating', $5)
      `, [attemptId, userId, idempotencyKey, billingPeriod, expiresAt]);
      return { state: 'created', attemptId, ...context };
    });
  }

  async saveCustomer(userId: string, stripeCustomerId: string): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const saved = await client.query(`
        INSERT INTO billing_customer (user_id, stripe_customer_id)
        SELECT user_id, $2 FROM user_account WHERE user_id = $1 AND deleted_at IS NULL
        ON CONFLICT (user_id) DO UPDATE SET
          stripe_customer_id = EXCLUDED.stripe_customer_id,
          stripe_customer_deleted_at = NULL,
          stripe_reconciliation_due_at = clock_timestamp(),
          updated_at = clock_timestamp()
        WHERE billing_customer.stripe_customer_id = EXCLUDED.stripe_customer_id
          OR billing_customer.stripe_customer_deleted_at IS NOT NULL
        RETURNING user_id
      `, [userId, stripeCustomerId]);
      if (saved.rowCount !== 1) return false;
      await client.query(`
        DELETE FROM outbox_event AS event
        USING billing_checkout_session AS checkout
        WHERE event.event_type = 'billing.customer.reconcile'
          AND event.aggregate_id = checkout.id
          AND checkout.user_id = $1
          AND checkout.created_customer_id = $2
          AND event.status IN ('pending', 'completed', 'discarded')
      `, [userId, stripeCustomerId]);
      return true;
    });
  }

  async beginCustomerCreation(attemptId: string): Promise<CustomerCreation> {
    return this.database.transaction(async (client) => {
      const row = (await client.query<CustomerCreation>(`UPDATE billing_checkout_session
        SET customer_creation_started_at = COALESCE(customer_creation_started_at, clock_timestamp())
        WHERE id = $1
        RETURNING id, user_id, customer_creation_started_at, created_customer_id, customer_erased_at`, [attemptId])).rows[0];
      if (!row) throw new Error('checkout_attempt_missing');
      await client.query(`
        INSERT INTO outbox_event (id, event_type, aggregate_id, available_at)
        VALUES (uuid_generate_v4(), 'billing.customer.reconcile', $1, $2::timestamptz + interval '23 hours')
        ON CONFLICT (event_type, aggregate_id) DO UPDATE
        SET status = 'pending', attempts = 0,
          available_at = EXCLUDED.available_at, locked_at = NULL, locked_by = NULL,
          last_error_code = NULL, processed_at = NULL, dead_lettered_at = NULL,
          resolved_at = NULL, resolved_by = NULL, resolution_reason = NULL
        WHERE outbox_event.status IN ('completed', 'discarded')
      `, [row.id, row.customer_creation_started_at]);
      return row;
    });
  }

  async recordCreatedCustomer(attemptId: string, customerId: string): Promise<void> {
    await this.database.transaction(async (client) => {
      const result = await client.query(`UPDATE billing_checkout_session SET created_customer_id = $2
        WHERE id = $1 AND (created_customer_id IS NULL OR created_customer_id = $2)`, [attemptId, customerId]);
      if (result.rowCount !== 1) throw new Error('checkout_customer_conflict');
      await client.query(`
        UPDATE outbox_event
        SET available_at = clock_timestamp()
        WHERE event_type = 'billing.customer.reconcile'
          AND aggregate_id = $1 AND status = 'pending'
      `, [attemptId]);
    });
  }

  async customerCreationsForErasure(userId: string): Promise<CustomerCreation[]> {
    return (await this.database.query<CustomerCreation>(`SELECT id, user_id, customer_creation_started_at, created_customer_id, customer_erased_at
      FROM billing_checkout_session WHERE user_id = $1 AND customer_creation_started_at IS NOT NULL
        AND customer_erased_at IS NULL ORDER BY id LIMIT 50`, [userId])).rows;
  }

  async markCreatedCustomerErased(attemptId: string): Promise<void> {
    await this.database.query('UPDATE billing_checkout_session SET customer_erased_at = clock_timestamp() WHERE id = $1', [attemptId]);
  }

  async markCheckoutOpen(attemptId: string, session: CheckoutSessionView): Promise<boolean> {
    return (await this.database.query(`
      UPDATE billing_checkout_session
      SET stripe_session_id = $2, checkout_url = $3, status = 'open', expires_at = $4,
        updated_at = clock_timestamp()
      WHERE id = $1 AND status = 'creating'
    `, [attemptId, session.session_id, session.url, session.expires_at])).rowCount === 1;
  }

  async markCheckoutFailed(attemptId: string): Promise<void> {
    await this.database.query(`
      UPDATE billing_checkout_session
      SET status = 'failed', checkout_url = NULL, updated_at = clock_timestamp()
      WHERE id = $1 AND status = 'creating'
    `, [attemptId]);
  }

  async processWebhook<T>(metadata: WebhookMetadata, work: (database: Queryable) => Promise<T>): Promise<{ duplicate: boolean; result?: T }> {
    return this.database.transaction(async (client) => {
      const inserted = await client.query(`
        INSERT INTO stripe_webhook_event
          (id, event_type, object_id, livemode, api_version, stripe_created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `, [metadata.id, metadata.type, metadata.objectId, metadata.livemode, metadata.apiVersion, metadata.createdAt]);
      if (!inserted.rows[0]) return { duplicate: true };
      return { duplicate: false, result: await work(client) };
    });
  }

  async webhookProcessed(eventId: string): Promise<boolean> {
    return (await this.database.query(`
      SELECT 1 FROM stripe_webhook_event WHERE id = $1
    `, [eventId])).rows[0] !== undefined;
  }

  async resolveBillingUser(
    stripeCustomerId: string,
    metadataUserId: string | null,
    database: Queryable,
  ): Promise<string | undefined> {
    const mapped = (await database.query<{ user_id: string }>(`
      SELECT user_id FROM billing_customer WHERE stripe_customer_id = $1
    `, [stripeCustomerId])).rows[0]?.user_id;
    const owner = mapped ?? metadataUserId;
    if (owner) await this.requireActiveBillingAccount(owner, database);
    if (mapped) {
      if (metadataUserId && metadataUserId !== mapped) throw new BillingMappingError('Stripe customer metadata conflicts with its Histae owner');
      await this.lockCustomerMapping(stripeCustomerId, mapped, database);
      return mapped;
    }
    if (!metadataUserId) return undefined;
    const inserted = await database.query<{ user_id: string }>(`
      INSERT INTO billing_customer (user_id, stripe_customer_id)
      SELECT user_id, $2 FROM user_account WHERE user_id = $1 AND deleted_at IS NULL
      ON CONFLICT (user_id) DO UPDATE SET updated_at = clock_timestamp()
      WHERE billing_customer.stripe_customer_id = EXCLUDED.stripe_customer_id
      RETURNING user_id
    `, [metadataUserId, stripeCustomerId]);
    if (!inserted.rows[0]) throw new BillingMappingError('Stripe customer could not be mapped to an active Histae account');
    return inserted.rows[0].user_id;
  }

  async upsertSubscription(input: SubscriptionProjection, database: Queryable): Promise<void> {
    const result = await database.query(`
      INSERT INTO user_subscription (
        user_id, plan, provider, provider_subscription_id, provider_price_id,
        billing_period, status, cancel_at_period_end, current_period_starts_at,
        current_period_ends_at, trial_ends_at, canceled_at, provider_event_created_at,
        projection_version, provider_snapshot_at, updated_at
      ) VALUES ($1, 'premium', 'stripe', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, $11, clock_timestamp())
      ON CONFLICT (user_id) DO UPDATE SET
        plan = 'premium', provider = 'stripe', provider_subscription_id = EXCLUDED.provider_subscription_id,
        provider_price_id = EXCLUDED.provider_price_id, billing_period = EXCLUDED.billing_period,
        status = EXCLUDED.status, cancel_at_period_end = EXCLUDED.cancel_at_period_end,
        current_period_starts_at = EXCLUDED.current_period_starts_at,
        current_period_ends_at = EXCLUDED.current_period_ends_at,
        trial_ends_at = EXCLUDED.trial_ends_at, canceled_at = EXCLUDED.canceled_at,
        provider_event_created_at = EXCLUDED.provider_event_created_at,
        provider_snapshot_at = GREATEST(user_subscription.provider_snapshot_at, EXCLUDED.provider_snapshot_at),
        projection_version = user_subscription.projection_version + 1,
        updated_at = clock_timestamp()
      WHERE (
          user_subscription.provider_subscription_id IS NULL
          OR user_subscription.provider_subscription_id = EXCLUDED.provider_subscription_id
          OR user_subscription.status NOT IN ('trialing', 'active', 'past_due')
        )
        AND (
          user_subscription.provider_event_created_at IS NULL
          OR user_subscription.provider_event_created_at < EXCLUDED.provider_event_created_at
          OR (
            user_subscription.provider_event_created_at = EXCLUDED.provider_event_created_at
            AND (
              user_subscription.status NOT IN ('canceled', 'unpaid', 'incomplete_expired')
              OR EXCLUDED.status IN ('canceled', 'unpaid', 'incomplete_expired')
            )
          )
        )
        AND (
          user_subscription.provider_snapshot_at IS NULL
          OR user_subscription.provider_snapshot_at <= EXCLUDED.provider_snapshot_at
        )
      RETURNING user_id
    `, [
      input.userId,
      input.stripeSubscriptionId,
      input.stripePriceId,
      input.billingPeriod,
      input.status,
      input.cancelAtPeriodEnd,
      input.currentPeriodStartsAt,
      input.currentPeriodEndsAt,
      input.trialEndsAt,
      input.canceledAt,
      input.eventCreatedAt,
    ]);
    if (!result.rows[0]) {
      const current = (await database.query<{ provider_subscription_id: string; provider_event_created_at: Date | null }>(`
        SELECT provider_subscription_id, provider_event_created_at FROM user_subscription WHERE user_id = $1
      `, [input.userId])).rows[0];
      if (current?.provider_subscription_id === input.stripeSubscriptionId
        && current.provider_event_created_at !== null
        && current.provider_event_created_at >= input.eventCreatedAt) return;
      throw new BillingMappingError('A different active Stripe subscription already owns this entitlement');
    }
    if (input.trialStartsAt) {
      await database.query(`
        UPDATE billing_customer
        SET trial_used_at = COALESCE(trial_used_at, $2), updated_at = clock_timestamp()
        WHERE user_id = $1 AND stripe_customer_id = $3
      `, [input.userId, input.trialStartsAt, input.stripeCustomerId]);
    }
  }

  async upsertInvoice(userId: string, input: InvoiceProjection, database: Queryable): Promise<void> {
    await database.query(`
      INSERT INTO billing_invoice (
        stripe_invoice_id, user_id, stripe_customer_id, stripe_subscription_id,
        status, currency, amount_due, amount_paid, amount_remaining,
        period_starts_at, period_ends_at, paid_at, created_at,
        provider_event_created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, clock_timestamp())
      ON CONFLICT (stripe_invoice_id) DO UPDATE SET
        user_id = EXCLUDED.user_id, stripe_customer_id = EXCLUDED.stripe_customer_id,
        stripe_subscription_id = EXCLUDED.stripe_subscription_id, status = EXCLUDED.status,
        currency = EXCLUDED.currency, amount_due = EXCLUDED.amount_due,
        amount_paid = EXCLUDED.amount_paid, amount_remaining = EXCLUDED.amount_remaining,
        period_starts_at = EXCLUDED.period_starts_at, period_ends_at = EXCLUDED.period_ends_at,
        paid_at = EXCLUDED.paid_at, provider_event_created_at = EXCLUDED.provider_event_created_at,
        updated_at = clock_timestamp()
      WHERE billing_invoice.provider_event_created_at IS NULL
        OR billing_invoice.provider_event_created_at < EXCLUDED.provider_event_created_at
        OR (
          billing_invoice.provider_event_created_at = EXCLUDED.provider_event_created_at
          AND (
            billing_invoice.status NOT IN ('paid', 'void', 'uncollectible')
            OR EXCLUDED.status IN ('paid', 'void', 'uncollectible')
          )
        )
    `, [
      input.stripeInvoiceId,
      userId,
      input.stripeCustomerId,
      input.stripeSubscriptionId,
      input.status,
      input.currency,
      input.amountDue,
      input.amountPaid,
      input.amountRemaining,
      input.periodStartsAt,
      input.periodEndsAt,
      input.paidAt,
      input.createdAt,
      input.eventCreatedAt,
    ]);
  }

  async markCheckoutFromWebhook(sessionId: string, status: 'completed' | 'expired', database: Queryable): Promise<string | undefined> {
    return (await database.query<{ user_id: string }>(`
      UPDATE billing_checkout_session
      SET status = $2, checkout_url = NULL, updated_at = clock_timestamp()
      WHERE stripe_session_id = $1 AND status IN ('open', 'creating')
      RETURNING user_id
    `, [sessionId, status])).rows[0]?.user_id;
  }

  async markCustomerDeleted(stripeCustomerId: string, eventCreatedAt: Date, database: Queryable): Promise<string | undefined> {
    const userId = (await database.query<{ user_id: string }>(`
      SELECT user_id FROM billing_customer WHERE stripe_customer_id = $1
    `, [stripeCustomerId])).rows[0]?.user_id;
    if (!userId) return undefined;
    await this.requireActiveBillingAccount(userId, database);
    await this.lockCustomerMapping(stripeCustomerId, userId, database);
    await database.query(`
      UPDATE user_subscription
      SET status = 'canceled', cancel_at_period_end = false,
        canceled_at = COALESCE(canceled_at, $2), provider_event_created_at = GREATEST(provider_event_created_at, $2),
        provider_snapshot_at = GREATEST(provider_snapshot_at, $2),
        projection_version = projection_version + 1,
        updated_at = clock_timestamp()
      WHERE user_id = $1 AND provider = 'stripe'
        AND (provider_snapshot_at IS NULL OR provider_snapshot_at <= $2)
    `, [userId, eventCreatedAt]);
    await database.query(`
      UPDATE billing_checkout_session
      SET status = 'failed', checkout_url = NULL, updated_at = clock_timestamp()
      WHERE user_id = $1 AND status IN ('creating', 'open')
    `, [userId]);
    await database.query(`
      UPDATE billing_customer
      SET stripe_customer_deleted_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE user_id = $1
    `, [userId]);
    return userId;
  }

  private async checkoutContext(userId: string, database: Queryable): Promise<Omit<CheckoutContext, 'attemptId'> | undefined> {
    const row = (await database.query<{
      trial_days: number;
      stripe_customer_id: string | null;
      trial_used_at: Date | null;
    }>(`
      SELECT plan.trial_days,
        CASE WHEN customer.stripe_customer_deleted_at IS NULL THEN customer.stripe_customer_id ELSE NULL END AS stripe_customer_id,
        customer.trial_used_at
      FROM subscription_plan AS plan
      LEFT JOIN billing_customer AS customer ON customer.user_id = $1
      WHERE plan.code = 'premium' AND plan.is_active = true
    `, [userId])).rows[0];
    return row ? {
      stripeCustomerId: row.stripe_customer_id,
      trialDays: row.trial_days,
      trialUsed: row.trial_used_at !== null,
    } : undefined;
  }

  private async requireActiveBillingAccount(userId: string, database: Queryable): Promise<void> {
    const account = (await database.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM user_account WHERE user_id = $1 FOR SHARE', [userId],
    )).rows[0];
    if (account?.deleted_at) throw new BillingAccountInactiveError();
    if (!account) throw new BillingMappingError('Stripe customer account does not exist');
  }

  private async lockCustomerMapping(customerId: string, userId: string, database: Queryable): Promise<void> {
    const locked = await database.query(`SELECT user_id FROM billing_customer
      WHERE stripe_customer_id = $1 AND user_id = $2 FOR UPDATE`, [customerId, userId]);
    if (!locked.rows[0]) throw new BillingMappingError('Stripe customer mapping changed concurrently');
  }

  private async hasActiveSubscription(userId: string, now: Date, database: Queryable): Promise<boolean> {
    return (await database.query(`
      SELECT 1 FROM user_subscription
      WHERE user_id = $1 AND plan = 'premium'
        AND (
          (provider IS NULL AND (current_period_ends_at IS NULL OR current_period_ends_at > $2))
          OR
          (provider = 'stripe' AND status IN ('trialing', 'active', 'past_due')
            AND (current_period_ends_at IS NULL OR current_period_ends_at > $2))
        )
      LIMIT 1
    `, [userId, now])).rows[0] !== undefined;
  }
}
