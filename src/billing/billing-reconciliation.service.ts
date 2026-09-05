import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import type Stripe from 'stripe';

import { cursorPage, decodeCursor, type CursorPage } from '../common/pagination';
import { ConfigService } from '../config/config.service';
import { AccountActivityService } from '../database/account-activity.service';
import { MobileDeliveryService } from '../mobile/mobile-delivery.service';
import { MaintenanceTrackerService } from '../operations/maintenance-tracker.service';
import { BillingMappingError, BillingReconciliationError } from './billing.errors';
import type {
  BillingReconciliationEventType,
  BillingReconciliationItem,
  BillingReconciliationKind,
  CustomerCreationReconciliationContext,
  SubscriptionProjection,
  SubscriptionReconciliationContext,
} from './billing.models';
import { BillingReconciliationRepository } from './billing-reconciliation.repository';
import { StripeGateway } from './stripe.gateway';
import { StripeProjectionMapper, stripeObjectId } from './stripe-projection.mapper';
import { CUSTOMER_CREATE_IDEMPOTENCY_SAFETY_MILLIS } from './billing.constants';

const LEGACY_CUSTOMER_WINDOW_MILLIS = 5 * 60_000;
const CURRENT_SUBSCRIPTION_STATUSES = new Set<Stripe.Subscription.Status>([
  'incomplete', 'trialing', 'active', 'past_due', 'paused',
]);

@Injectable()
export class BillingReconciliationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingReconciliationService.name);
  private readonly projections: StripeProjectionMapper;
  private timer?: NodeJS.Timeout;
  private scheduling = false;

  constructor(
    private readonly repository: BillingReconciliationRepository,
    private readonly stripe: StripeGateway,
    private readonly config: ConfigService,
    private readonly activity: AccountActivityService,
    private readonly tracker: MaintenanceTrackerService,
    private readonly delivery: MobileDeliveryService,
  ) {
    this.projections = new StripeProjectionMapper(config.billing);
  }

  onModuleInit(): void {
    if (!this.embeddedSchedulerEnabled) return;
    void this.scheduleTracked();
    this.timer = setInterval(
      () => void this.scheduleTracked(),
      this.config.billing.reconciliationIntervalMillis,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(now = new Date()): Promise<number | undefined> {
    return this.tracker.track(
      'billing',
      () => this.scheduleDue(now),
      (count) => count ?? 0,
    );
  }

  async process(eventType: BillingReconciliationEventType, aggregateId: string): Promise<void> {
    if (!this.providerEnabled) throw new BillingReconciliationError('billing_reconciliation_disabled');
    if (eventType === 'billing.subscription.reconcile') {
      await this.reconcileSubscription(aggregateId);
      return;
    }
    await this.reconcileCustomerCreation(aggregateId);
  }

  async list(
    kind: BillingReconciliationKind | 'all',
    limit: number,
    rawCursor?: string,
  ): Promise<CursorPage<BillingReconciliationItem>> {
    const rows = await this.repository.list(kind, limit + 1, decodeCursor(rawCursor));
    const page = cursorPage(rows, limit, (row) => row.cursor_at);
    return {
      items: page.items.map((row) => ({
        event_id: row.id,
        user_id: row.user_id,
        kind: row.kind,
        attempts: row.attempts,
        last_error_code: row.last_error_code,
        created_at: row.created_at,
        dead_lettered_at: row.dead_lettered_at,
      })),
      next_cursor: page.next_cursor,
    };
  }

  private async reconcileSubscription(userId: string): Promise<void> {
    const initial = await this.repository.subscriptionContext(userId);
    if (!initial) return;
    await this.activity.runExisting([initial.userId], async (assertHeld) => {
      const context = await this.repository.subscriptionContext(initial.userId);
      if (!context) return;
      const snapshotAt = new Date();
      let projection: SubscriptionProjection | null;
      let customerDeleted: boolean;
      try {
        const customer = await this.stripe.retrieveCustomer(context.stripeCustomerId);
        assertHeld();
        customerDeleted = customer.deleted === true;
        projection = customerDeleted ? null : await this.subscriptionProjection(context, snapshotAt);
        assertHeld();
      } catch (error: unknown) {
        throw normalizeReconciliationError(error, 'billing_provider_unavailable');
      }
      const result = await this.repository.applySubscription(
        context,
        projection,
        snapshotAt,
        new Date(snapshotAt.getTime() + this.config.billing.reconciliationFreshnessMillis),
        customerDeleted,
      );
      assertHeld();
      if (result.state === 'conflict') {
        throw new BillingReconciliationError('billing_subscription_mapping_conflict', true);
      }
      if (result.state === 'applied' && result.status && result.status !== result.previousStatus) {
        await this.delivery.subscriptionUpdated(context.userId, result.status);
      }
    });
  }

  private async subscriptionProjection(
    context: SubscriptionReconciliationContext,
    snapshotAt: Date,
  ): Promise<SubscriptionProjection | null> {
    const listed = await this.stripe.listCustomerSubscriptions(context.stripeCustomerId);
    if (listed.truncated) {
      throw new BillingReconciliationError('billing_subscription_set_too_large', true);
    }
    const premium = listed.subscriptions.filter((subscription) => subscription.items.data.some(
      (item) => stripeObjectId(item.price.product) === this.config.billing.premiumProductId,
    ));
    const current = premium.filter((subscription) => CURRENT_SUBSCRIPTION_STATUSES.has(subscription.status));
    if (current.length > 1) {
      throw new BillingReconciliationError('billing_multiple_current_subscriptions', true);
    }
    const selected = current[0] ?? premium.sort((left, right) => right.created - left.created)[0];
    if (!selected) return null;
    const parsed = this.projections.subscription(selected);
    if (parsed.stripeCustomerId !== context.stripeCustomerId
      || (parsed.metadataUserId && parsed.metadataUserId !== context.userId)) {
      throw new BillingReconciliationError('billing_subscription_mapping_conflict', true);
    }
    return { ...parsed, userId: context.userId, eventCreatedAt: snapshotAt };
  }

  private async reconcileCustomerCreation(attemptId: string): Promise<void> {
    const initial = await this.repository.customerCreationContext(attemptId);
    if (!initial || customerCreationResolved(initial)) return;
    if (!initial.createdCustomerId
      && Date.now() - initial.startedAt.getTime() < CUSTOMER_CREATE_IDEMPOTENCY_SAFETY_MILLIS) {
      throw new BillingReconciliationError('billing_customer_not_due');
    }
    await this.activity.runExisting([initial.userId], async (assertHeld) => {
      const context = await this.repository.customerCreationContext(initial.attemptId);
      if (!context || customerCreationResolved(context)) return;
      const customerId = context.createdCustomerId ?? await this.findCreatedCustomer(context);
      assertHeld();
      const result = await this.repository.recoverCustomerCreation(context.attemptId, customerId);
      assertHeld();
      if (result === 'conflict') {
        throw new BillingReconciliationError('billing_customer_mapping_conflict', true);
      }
    });
  }

  private async findCreatedCustomer(context: CustomerCreationReconciliationContext): Promise<string | null> {
    try {
      const exact = await this.stripe.searchCustomersByAttempt(context.attemptId);
      if (exact.truncated || exact.customers.length > 1) {
        throw new BillingReconciliationError('billing_customer_search_ambiguous', true);
      }
      if (exact.customers[0]) {
        const customer = exact.customers[0];
        if (customer.metadata.histae_user_id !== context.userId) {
          throw new BillingReconciliationError('billing_customer_mapping_conflict', true);
        }
        return customer.id;
      }

      // Compatibility for attempts created before the attempt metadata existed.
      const legacy = await this.stripe.listCustomersCreatedBetween(
        new Date(context.startedAt.getTime() - LEGACY_CUSTOMER_WINDOW_MILLIS),
        new Date(context.startedAt.getTime() + LEGACY_CUSTOMER_WINDOW_MILLIS),
      );
      const candidates = legacy.customers.filter((customer) =>
        customer.metadata.histae_user_id === context.userId
        && (!customer.metadata.histae_customer_attempt_id
          || customer.metadata.histae_customer_attempt_id === context.attemptId),
      );
      if (legacy.truncated || candidates.length > 1) {
        throw new BillingReconciliationError('billing_customer_search_ambiguous', true);
      }
      return candidates[0]?.id ?? null;
    } catch (error: unknown) {
      throw normalizeReconciliationError(error, 'billing_provider_unavailable');
    }
  }

  private async scheduleTracked(): Promise<void> {
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      await this.runOnce();
    } catch {
      this.logger.error('billing_reconciliation_schedule_failed');
    } finally {
      this.scheduling = false;
    }
  }

  private get providerEnabled(): boolean {
    return this.config.billing.provider === 'stripe';
  }

  private get embeddedSchedulerEnabled(): boolean {
    return this.config.maintenanceMode === 'api' && this.providerEnabled;
  }

  private scheduleDue(now: Date): Promise<number | undefined> {
    if (!this.providerEnabled) return Promise.resolve(undefined);
    return this.repository.scheduleDue(
      now,
      this.config.billing.reconciliationBatchSize,
    );
  }
}

function normalizeReconciliationError(error: unknown, fallback: string): BillingReconciliationError {
  if (error instanceof BillingReconciliationError) return error;
  if (error instanceof BillingMappingError) {
    return new BillingReconciliationError('billing_projection_invalid', true);
  }
  return new BillingReconciliationError(fallback);
}

function customerCreationResolved(context: CustomerCreationReconciliationContext): boolean {
  return context.customerErasedAt !== null
    || (context.createdCustomerId !== null
      && context.createdCustomerId === context.mappedCustomerId);
}
