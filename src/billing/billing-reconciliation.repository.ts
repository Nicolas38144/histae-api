import { Injectable } from '@nestjs/common';

import type { KeysetCursor } from '../common/pagination';
import { DatabaseService } from '../database/database.service';
import type {
  BillingReconciliationKind,
  BillingReconciliationRow,
  CustomerCreationReconciliationContext,
  StripeSubscriptionStatus,
  SubscriptionProjection,
  SubscriptionReconciliationContext,
} from './billing.models';

export type ReconciliationApplyResult = {
  state: 'applied' | 'stale' | 'not_found' | 'conflict';
  previousStatus: StripeSubscriptionStatus | null;
  status: StripeSubscriptionStatus | null;
};

export type CustomerRecoveryResult = 'recovered' | 'cleared' | 'already_resolved' | 'not_found' | 'conflict';

@Injectable()
export class BillingReconciliationRepository {
  constructor(private readonly database: DatabaseService) {}

  async scheduleDue(now: Date, limit: number): Promise<number> {
    return this.database.transaction(async (client) => {
      const customers = await client.query(`
        WITH candidates AS MATERIALIZED (
          SELECT checkout.id, checkout.customer_creation_started_at,
            checkout.created_customer_id
          FROM billing_checkout_session AS checkout
          JOIN user_account AS account ON account.user_id = checkout.user_id
          LEFT JOIN billing_customer AS mapping
            ON mapping.user_id = checkout.user_id
            AND mapping.stripe_customer_deleted_at IS NULL
          LEFT JOIN outbox_event AS queued
            ON queued.event_type = 'billing.customer.reconcile'
            AND queued.aggregate_id = checkout.id
          WHERE checkout.customer_creation_started_at IS NOT NULL
            AND checkout.customer_erased_at IS NULL
            AND account.deleted_at IS NULL
            AND (
              (checkout.created_customer_id IS NULL
                AND checkout.customer_creation_started_at <= $1::timestamptz - interval '23 hours')
              OR (checkout.created_customer_id IS NOT NULL
                AND mapping.stripe_customer_id IS DISTINCT FROM checkout.created_customer_id)
            )
            AND (queued.id IS NULL OR queued.status IN ('completed', 'discarded'))
          ORDER BY checkout.customer_creation_started_at, checkout.id
          FOR UPDATE OF checkout SKIP LOCKED
          LIMIT $2
        )
        INSERT INTO outbox_event (id, event_type, aggregate_id, available_at)
        SELECT uuid_generate_v4(), 'billing.customer.reconcile', id,
          CASE WHEN created_customer_id IS NULL
            THEN GREATEST(clock_timestamp(), customer_creation_started_at + interval '23 hours')
            ELSE clock_timestamp()
          END
        FROM candidates
        ON CONFLICT (event_type, aggregate_id) DO UPDATE
        SET status = 'pending', attempts = 0, available_at = EXCLUDED.available_at,
          locked_at = NULL, locked_by = NULL, last_error_code = NULL,
          processed_at = NULL, dead_lettered_at = NULL,
          resolved_at = NULL, resolved_by = NULL, resolution_reason = NULL
        WHERE outbox_event.status IN ('completed', 'discarded')
        RETURNING id
      `, [now, limit]);
      const remaining = Math.max(0, limit - (customers.rowCount ?? 0));
      if (remaining === 0) return customers.rowCount ?? 0;

      const subscriptions = await client.query(`
        WITH candidates AS MATERIALIZED (
          SELECT customer.user_id
          FROM billing_customer AS customer
          JOIN user_account AS account ON account.user_id = customer.user_id
          LEFT JOIN outbox_event AS queued
            ON queued.event_type = 'billing.subscription.reconcile'
            AND queued.aggregate_id = customer.user_id
          WHERE customer.stripe_customer_deleted_at IS NULL
            AND customer.stripe_reconciliation_due_at <= $1
            AND account.deleted_at IS NULL
            AND (queued.id IS NULL OR queued.status IN ('completed', 'discarded'))
          ORDER BY customer.stripe_reconciliation_due_at, customer.user_id
          FOR UPDATE OF customer SKIP LOCKED
          LIMIT $2
        )
        INSERT INTO outbox_event (id, event_type, aggregate_id)
        SELECT uuid_generate_v4(), 'billing.subscription.reconcile', user_id FROM candidates
        ON CONFLICT (event_type, aggregate_id) DO UPDATE
        SET status = 'pending', attempts = 0, available_at = clock_timestamp(),
          locked_at = NULL, locked_by = NULL, last_error_code = NULL,
          processed_at = NULL, dead_lettered_at = NULL,
          resolved_at = NULL, resolved_by = NULL, resolution_reason = NULL
        WHERE outbox_event.status IN ('completed', 'discarded')
        RETURNING id
      `, [now, remaining]);
      return (subscriptions.rowCount ?? 0) + (customers.rowCount ?? 0);
    });
  }

  async subscriptionContext(userId: string): Promise<SubscriptionReconciliationContext | undefined> {
    return (await this.database.query<{
      user_id: string;
      stripe_customer_id: string;
      projection_version: string | number | null;
    }>(`
      SELECT customer.user_id, customer.stripe_customer_id, subscription.projection_version
      FROM billing_customer AS customer
      JOIN user_account AS account ON account.user_id = customer.user_id
      LEFT JOIN user_subscription AS subscription ON subscription.user_id = customer.user_id
      WHERE customer.user_id = $1
        AND customer.stripe_customer_deleted_at IS NULL
        AND account.deleted_at IS NULL
    `, [userId])).rows.map((row) => ({
      userId: row.user_id,
      stripeCustomerId: row.stripe_customer_id,
      projectionVersion: row.projection_version === null ? null : Number(row.projection_version),
    }))[0];
  }

  async customerCreationContext(attemptId: string): Promise<CustomerCreationReconciliationContext | undefined> {
    const row = (await this.database.query<{
      id: string;
      user_id: string;
      customer_creation_started_at: Date;
      created_customer_id: string | null;
      mapped_customer_id: string | null;
      customer_erased_at: Date | null;
    }>(`
      SELECT checkout.id, checkout.user_id, checkout.customer_creation_started_at,
        checkout.created_customer_id, checkout.customer_erased_at,
        customer.stripe_customer_id AS mapped_customer_id
      FROM billing_checkout_session AS checkout
      JOIN user_account AS account ON account.user_id = checkout.user_id
      LEFT JOIN billing_customer AS customer
        ON customer.user_id = checkout.user_id
        AND customer.stripe_customer_deleted_at IS NULL
      WHERE checkout.id = $1 AND checkout.customer_creation_started_at IS NOT NULL
        AND account.deleted_at IS NULL
    `, [attemptId])).rows[0];
    return row ? {
      attemptId: row.id,
      userId: row.user_id,
      startedAt: row.customer_creation_started_at,
      createdCustomerId: row.created_customer_id,
      mappedCustomerId: row.mapped_customer_id,
      customerErasedAt: row.customer_erased_at,
    } : undefined;
  }

  async applySubscription(
    context: SubscriptionReconciliationContext,
    projection: SubscriptionProjection | null,
    snapshotAt: Date,
    nextDueAt: Date,
    customerDeleted = false,
  ): Promise<ReconciliationApplyResult> {
    try {
      return await this.database.transaction(async (client) => {
      const mapping = (await client.query<{ stripe_customer_id: string }>(`
        SELECT customer.stripe_customer_id
        FROM billing_customer AS customer
        JOIN user_account AS account ON account.user_id = customer.user_id
        WHERE customer.user_id = $1 AND customer.stripe_customer_deleted_at IS NULL
          AND account.deleted_at IS NULL
        FOR UPDATE OF customer
      `, [context.userId])).rows[0];
      if (!mapping || mapping.stripe_customer_id !== context.stripeCustomerId) {
        return { state: 'not_found', previousStatus: null, status: null };
      }
      const current = (await client.query<{
        provider: 'stripe' | null;
        status: StripeSubscriptionStatus | null;
        projection_version: string | number;
        provider_snapshot_at: Date | null;
      }>(`
        SELECT provider, status, projection_version, provider_snapshot_at
        FROM user_subscription WHERE user_id = $1 FOR UPDATE
      `, [context.userId])).rows[0];
      const currentVersion = current ? Number(current.projection_version) : null;
      if (currentVersion !== context.projectionVersion
        || (current?.provider_snapshot_at && current.provider_snapshot_at > snapshotAt)) {
        return { state: 'stale', previousStatus: current?.status ?? null, status: current?.status ?? null };
      }

      let nextStatus = current?.status ?? null;
      if (projection) {
        nextStatus = projection.status;
        await client.query(`
          INSERT INTO user_subscription (
            user_id, plan, provider, provider_subscription_id, provider_price_id,
            billing_period, status, cancel_at_period_end, current_period_starts_at,
            current_period_ends_at, trial_ends_at, canceled_at, projection_version,
            provider_snapshot_at, updated_at
          ) VALUES ($1, 'premium', 'stripe', $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, clock_timestamp())
          ON CONFLICT (user_id) DO UPDATE SET
            plan = 'premium', provider = 'stripe',
            provider_subscription_id = EXCLUDED.provider_subscription_id,
            provider_price_id = EXCLUDED.provider_price_id,
            billing_period = EXCLUDED.billing_period, status = EXCLUDED.status,
            cancel_at_period_end = EXCLUDED.cancel_at_period_end,
            current_period_starts_at = EXCLUDED.current_period_starts_at,
            current_period_ends_at = EXCLUDED.current_period_ends_at,
            trial_ends_at = EXCLUDED.trial_ends_at, canceled_at = EXCLUDED.canceled_at,
            projection_version = user_subscription.projection_version + 1,
            provider_snapshot_at = EXCLUDED.provider_snapshot_at,
            updated_at = clock_timestamp()
        `, [
          context.userId,
          projection.stripeSubscriptionId,
          projection.stripePriceId,
          projection.billingPeriod,
          projection.status,
          projection.cancelAtPeriodEnd,
          projection.currentPeriodStartsAt,
          projection.currentPeriodEndsAt,
          projection.trialEndsAt,
          projection.canceledAt,
          snapshotAt,
        ]);
        if (projection.trialStartsAt) {
          await client.query(`UPDATE billing_customer
            SET trial_used_at = COALESCE(trial_used_at, $2)
            WHERE user_id = $1`, [context.userId, projection.trialStartsAt]);
        }
      } else if (current?.provider === 'stripe') {
        nextStatus = 'canceled';
        await client.query(`
          UPDATE user_subscription
          SET status = 'canceled', cancel_at_period_end = false,
            canceled_at = COALESCE(canceled_at, $2),
            projection_version = projection_version + 1,
            provider_snapshot_at = $2, updated_at = clock_timestamp()
          WHERE user_id = $1
        `, [context.userId, snapshotAt]);
      }
      await client.query(`
        UPDATE billing_customer
        SET stripe_reconciled_at = $2, stripe_reconciliation_due_at = $3,
          stripe_customer_deleted_at = CASE WHEN $4 THEN COALESCE(stripe_customer_deleted_at, $2) ELSE stripe_customer_deleted_at END,
          updated_at = clock_timestamp()
        WHERE user_id = $1
      `, [context.userId, snapshotAt, nextDueAt, customerDeleted]);
      return {
        state: 'applied',
        previousStatus: current?.status ?? null,
        status: nextStatus,
      };
      });
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        return { state: 'conflict', previousStatus: null, status: null };
      }
      throw error;
    }
  }

  async recoverCustomerCreation(attemptId: string, stripeCustomerId: string | null): Promise<CustomerRecoveryResult> {
    try {
      return await this.database.transaction(async (client) => {
        const checkout = (await client.query<{
          user_id: string;
          created_customer_id: string | null;
          customer_erased_at: Date | null;
        }>(`
          SELECT checkout.user_id, checkout.created_customer_id, checkout.customer_erased_at
          FROM billing_checkout_session AS checkout
          JOIN user_account AS account ON account.user_id = checkout.user_id
          WHERE checkout.id = $1 AND account.deleted_at IS NULL
          FOR UPDATE OF checkout
        `, [attemptId])).rows[0];
        if (!checkout) return 'not_found';
        if (checkout.customer_erased_at) return 'already_resolved';
        if (checkout.created_customer_id && stripeCustomerId
          && checkout.created_customer_id !== stripeCustomerId) return 'conflict';
        const recoveredCustomerId = checkout.created_customer_id ?? stripeCustomerId;
        if (!recoveredCustomerId) {
          await client.query(`
            UPDATE billing_checkout_session
            SET customer_creation_started_at = NULL, status = 'failed',
              checkout_url = NULL, updated_at = clock_timestamp()
            WHERE id = $1
          `, [attemptId]);
          return 'cleared';
        }
        const customer = await client.query(`
          INSERT INTO billing_customer (
            user_id, stripe_customer_id, stripe_reconciliation_due_at
          ) VALUES ($1, $2, clock_timestamp())
          ON CONFLICT (user_id) DO UPDATE SET
            stripe_customer_id = EXCLUDED.stripe_customer_id,
            stripe_customer_deleted_at = NULL,
            stripe_reconciliation_due_at = clock_timestamp(),
            updated_at = clock_timestamp()
          WHERE billing_customer.stripe_customer_id = EXCLUDED.stripe_customer_id
            OR billing_customer.stripe_customer_deleted_at IS NOT NULL
          RETURNING user_id
        `, [checkout.user_id, recoveredCustomerId]);
        if (!customer.rows[0]) return 'conflict';
        await client.query(`
          UPDATE billing_checkout_session
          SET created_customer_id = $2, status = 'failed', checkout_url = NULL,
            updated_at = clock_timestamp()
          WHERE id = $1
        `, [attemptId, recoveredCustomerId]);
        return 'recovered';
      });
    } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') return 'conflict';
      throw error;
    }
  }

  async list(
    kind: BillingReconciliationKind | 'all',
    limit: number,
    cursor?: KeysetCursor,
  ): Promise<BillingReconciliationRow[]> {
    return (await this.database.query<BillingReconciliationRow>(`
      SELECT event.id,
        CASE WHEN event.event_type = 'billing.subscription.reconcile'
          THEN event.aggregate_id ELSE checkout.user_id END AS user_id,
        CASE WHEN event.event_type = 'billing.subscription.reconcile'
          THEN 'subscription' ELSE 'customer_creation' END AS kind,
        event.attempts, event.last_error_code, event.created_at,
        event.dead_lettered_at, event.dead_lettered_at AS cursor_at
      FROM outbox_event AS event
      LEFT JOIN billing_checkout_session AS checkout
        ON event.event_type = 'billing.customer.reconcile' AND checkout.id = event.aggregate_id
      WHERE event.event_type IN ('billing.subscription.reconcile', 'billing.customer.reconcile')
        AND event.status = 'dead_letter'
        AND (event.event_type = 'billing.subscription.reconcile' OR checkout.user_id IS NOT NULL)
        AND ($1 = 'all'
          OR ($1 = 'subscription' AND event.event_type = 'billing.subscription.reconcile')
          OR ($1 = 'customer_creation' AND event.event_type = 'billing.customer.reconcile'))
        AND ($3::timestamptz IS NULL
          OR (event.dead_lettered_at, event.id) < ($3::timestamptz, $4::uuid))
      ORDER BY cursor_at DESC, event.id DESC
      LIMIT $2
    `, [kind, limit, cursor?.at ?? null, cursor?.id ?? null])).rows;
  }
}
