import { Injectable, Logger } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import { ApiError, apiError } from '../common/api-error';
import { normalizeIdempotencyKey } from '../common/idempotency';
import { ConfigService } from '../config/config.service';
import type { Queryable } from '../database/database.service';
import { MobileDeliveryService } from '../mobile/mobile-delivery.service';
import type {
  BillingPeriod,
  CheckoutSessionView,
  InvoiceProjection,
  StripeSubscriptionStatus,
  SubscriptionProjection,
  SubscriptionView,
  WebhookMetadata,
} from './billing.models';
import { STRIPE_SUBSCRIPTION_STATUSES } from './billing.models';
import { BillingMappingError, BillingRepository } from './billing.repository';
import { StripeGateway } from './stripe.gateway';

const CHECKOUT_TTL_MILLIS = 30 * 60_000;
const CHECKOUT_CREATION_STALE_MILLIS = 60_000;
const PREMIUM_ACCESS_STATUSES = new Set<StripeSubscriptionStatus>(['trialing', 'active', 'past_due']);
const SUBSCRIPTION_EVENT_TYPES = new Set<string>([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'customer.subscription.trial_will_end',
]);
const INVOICE_EVENT_TYPES = new Set<string>([
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.payment_action_required',
  'invoice.finalization_failed',
]);
const CHECKOUT_EVENT_TYPES = new Set<string>(['checkout.session.completed', 'checkout.session.expired']);
const SUPPORTED_WEBHOOK_EVENT_TYPES = new Set<string>([
  ...SUBSCRIPTION_EVENT_TYPES,
  ...INVOICE_EVENT_TYPES,
  ...CHECKOUT_EVENT_TYPES,
  'customer.deleted',
]);

type WebhookEffect = {
  userId: string;
  paymentFailed?: boolean;
  trialEnding?: boolean;
  subscriptionStatus?: StripeSubscriptionStatus;
};

type ParsedSubscription = Omit<SubscriptionProjection, 'userId' | 'eventCreatedAt'> & { metadataUserId: string | null };

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly billing: BillingRepository,
    private readonly stripe: StripeGateway,
    private readonly config: ConfigService,
    private readonly delivery: MobileDeliveryService,
  ) {}

  async subscription(userId: string): Promise<SubscriptionView> {
    const [row, customerId] = await Promise.all([
      this.billing.subscriptionForUser(userId),
      this.billing.customerForUser(userId),
    ]);
    if (!row) return {
      plan: 'free',
      provider: null,
      status: null,
      access_granted: false,
      billing_period: null,
      cancel_at_period_end: false,
      current_period_starts_at: null,
      current_period_ends_at: null,
      trial_ends_at: null,
      canceled_at: null,
      customer_portal_available: this.enabled && customerId !== undefined,
    };
    const now = new Date();
    const withinPeriod = row.current_period_ends_at === null || row.current_period_ends_at > now;
    const accessGranted = row.plan === 'premium' && withinPeriod
      && (row.provider === null || (row.status !== null && PREMIUM_ACCESS_STATUSES.has(row.status)));
    return {
      plan: accessGranted ? 'premium' : 'free',
      provider: row.provider,
      status: row.status,
      access_granted: accessGranted,
      billing_period: row.billing_period,
      cancel_at_period_end: row.cancel_at_period_end,
      current_period_starts_at: row.current_period_starts_at,
      current_period_ends_at: row.current_period_ends_at,
      trial_ends_at: row.trial_ends_at,
      canceled_at: row.canceled_at,
      customer_portal_available: this.enabled && customerId !== undefined,
    };
  }

  async createCheckout(userId: string, billingPeriod: BillingPeriod, suppliedKey: string | undefined): Promise<CheckoutSessionView> {
    this.requireEnabled();
    const idempotencyKey = normalizeIdempotencyKey(suppliedKey);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CHECKOUT_TTL_MILLIS);
    const attempt = await this.billing.beginCheckout(
      userId,
      idempotencyKey,
      billingPeriod,
      randomUUID(),
      now,
      expiresAt,
      new Date(now.getTime() - CHECKOUT_CREATION_STALE_MILLIS),
    );
    if (attempt.state === 'replay') return attempt.session;
    if (attempt.state === 'not_found') throw apiError(404, 'account_not_found', 'The account could not be found or has been deleted.');
    if (attempt.state === 'already_subscribed') throw apiError(409, 'subscription_already_active', 'A Premium subscription is already active.');
    if (attempt.state === 'in_progress') throw apiError(409, 'checkout_already_in_progress', 'A Checkout session is already being created or is still open.');
    if (attempt.state === 'idempotency_conflict') throw apiError(409, 'idempotency_key_reused', 'This Idempotency-Key was already used with a different billing period.');
    if (attempt.state === 'idempotency_consumed') throw apiError(409, 'idempotency_key_consumed', 'This Idempotency-Key belongs to a completed or expired Checkout session.');

    let createdSessionId: string | undefined;
    let unattachedCustomerId: string | undefined;
    try {
      let customerId = attempt.stripeCustomerId;
      if (!customerId) {
        const customer = await this.stripe.createCustomer(userId, `histae-customer-${attempt.attemptId}`);
        customerId = customer.id;
        unattachedCustomerId = customer.id;
        if (!await this.billing.saveCustomer(userId, customerId)) {
          throw apiError(409, 'billing_customer_conflict', 'The Stripe customer could not be attached to this account.');
        }
        unattachedCustomerId = undefined;
      }
      const session = await this.stripe.createCheckoutSession({
        userId,
        customerId,
        priceId: billingPeriod === 'monthly'
          ? this.config.billing.premiumMonthlyPriceId
          : this.config.billing.premiumAnnualPriceId,
        billingPeriod,
        trialDays: attempt.trialUsed ? 0 : attempt.trialDays,
        expiresAt,
        idempotencyKey: `histae-checkout-${attempt.attemptId}`,
      });
      createdSessionId = session.id;
      if (!session.url) throw apiError(502, 'stripe_checkout_unavailable', 'Stripe did not return a hosted Checkout URL.');
      const view = { session_id: session.id, url: session.url, expires_at: new Date(session.expires_at * 1_000) };
      if (!await this.billing.markCheckoutOpen(attempt.attemptId, view)) {
        await this.expireBestEffort(session.id);
        throw apiError(409, 'checkout_state_conflict', 'The Checkout session could not be persisted safely.');
      }
      return view;
    } catch (error) {
      await this.billing.markCheckoutFailed(attempt.attemptId);
      if (createdSessionId) await this.expireBestEffort(createdSessionId);
      if (unattachedCustomerId) await this.deleteCustomerBestEffort(unattachedCustomerId, attempt.attemptId);
      if (error instanceof ApiError) throw error;
      throw this.providerError(error);
    }
  }

  async createPortal(userId: string): Promise<{ url: string }> {
    this.requireEnabled();
    const customerId = await this.billing.customerForUser(userId);
    if (!customerId) throw apiError(409, 'billing_customer_not_found', 'No Stripe customer exists for this account yet.');
    try {
      const session = await this.stripe.createPortalSession(customerId, `histae-portal-${randomUUID()}`);
      return { url: session.url };
    } catch (error) {
      throw this.providerError(error);
    }
  }

  async handleStripeWebhook(rawBody: Buffer | undefined, signature: string | undefined): Promise<void> {
    const event = this.verifiedWebhookEvent(rawBody, signature);
    if (!SUPPORTED_WEBHOOK_EVENT_TYPES.has(event.type) || await this.billing.webhookProcessed(event.id)) return;
    const invoice = INVOICE_EVENT_TYPES.has(event.type) ? event.data.object as Stripe.Invoice : undefined;
    const prefetchedSubscription = invoice ? await this.subscriptionForInvoice(invoice) : undefined;

    const metadata: WebhookMetadata = {
      id: event.id,
      type: event.type,
      objectId: objectId(event.data.object),
      livemode: event.livemode,
      apiVersion: event.api_version,
      createdAt: new Date(event.created * 1_000),
    };
    let processed: { duplicate: boolean; result?: WebhookEffect };
    try {
      processed = await this.billing.processWebhook(
        metadata,
        (database) => this.processWebhookEvent(event, metadata, invoice, prefetchedSubscription, database),
      );
    } catch (error) {
      if (error instanceof BillingMappingError) throw apiError(400, 'invalid_stripe_event', error.message, error);
      throw error;
    }
    if (!processed.duplicate && processed.result) await this.deliverBillingEffect(processed.result);
  }

  private verifiedWebhookEvent(rawBody: Buffer | undefined, signature: string | undefined): Stripe.Event {
    this.requireEnabled();
    if (!rawBody || !signature) throw apiError(400, 'invalid_stripe_signature', 'A signed raw Stripe webhook body is required.');
    let event: Stripe.Event;
    try {
      event = this.stripe.constructWebhookEvent(rawBody, signature);
    } catch (error) {
      throw apiError(400, 'invalid_stripe_signature', 'The Stripe webhook signature is invalid.', error);
    }
    const expectsLiveMode = this.config.billing.stripeSecretKey.startsWith('sk_live_');
    if (event.livemode !== expectsLiveMode) {
      throw apiError(400, 'stripe_mode_mismatch', 'The Stripe webhook event does not match the configured billing mode.');
    }
    return event;
  }

  private async subscriptionForInvoice(invoice: Stripe.Invoice): Promise<ParsedSubscription | undefined> {
    const subscriptionId = subscriptionIdForInvoice(invoice);
    if (!subscriptionId) return undefined;
    try {
      return this.parseSubscription(await this.stripe.retrieveSubscription(subscriptionId));
    } catch (error) {
      if (error instanceof BillingMappingError) throw apiError(400, 'invalid_stripe_event', error.message, error);
      throw this.providerError(error);
    }
  }

  private async processWebhookEvent(
    event: Stripe.Event,
    metadata: WebhookMetadata,
    invoice: Stripe.Invoice | undefined,
    prefetchedSubscription: ParsedSubscription | undefined,
    database: Queryable,
  ): Promise<WebhookEffect | undefined> {
    if (SUBSCRIPTION_EVENT_TYPES.has(event.type)) {
      const parsed = this.parseSubscription(event.data.object as Stripe.Subscription);
      const userId = await this.resolveUser(parsed, database, 'Stripe subscription has no Histae customer mapping');
      await this.billing.upsertSubscription({ ...parsed, userId, eventCreatedAt: metadata.createdAt }, database);
      return {
        userId,
        subscriptionStatus: parsed.status,
        trialEnding: event.type === 'customer.subscription.trial_will_end',
      };
    }
    if (invoice && prefetchedSubscription) {
      if (prefetchedSubscription.stripeCustomerId !== customerId(invoice.customer)) {
        throw new BillingMappingError('Stripe invoice customer does not own its subscription');
      }
      const userId = await this.resolveUser(prefetchedSubscription, database, 'Stripe invoice has no Histae customer mapping');
      await this.billing.upsertSubscription({ ...prefetchedSubscription, userId, eventCreatedAt: metadata.createdAt }, database);
      await this.billing.upsertInvoice(userId, this.parseInvoice(invoice, metadata.createdAt), database);
      return {
        userId,
        subscriptionStatus: prefetchedSubscription.status,
        paymentFailed: event.type === 'invoice.payment_failed' || event.type === 'invoice.payment_action_required',
      };
    }
    if (CHECKOUT_EVENT_TYPES.has(event.type)) {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = await this.billing.markCheckoutFromWebhook(
        session.id,
        event.type === 'checkout.session.completed' ? 'completed' : 'expired',
        database,
      );
      return userId ? { userId } : undefined;
    }
    if (event.type === 'customer.deleted') {
      const deletedCustomerId = objectId(event.data.object);
      if (!deletedCustomerId) throw new BillingMappingError('Stripe Customer deletion has no object ID');
      const userId = await this.billing.markCustomerDeleted(deletedCustomerId, metadata.createdAt, database);
      return userId ? { userId, subscriptionStatus: 'canceled' } : undefined;
    }
    return undefined;
  }

  private async resolveUser(parsed: ParsedSubscription, database: Queryable, missingMessage: string): Promise<string> {
    const userId = await this.billing.resolveBillingUser(parsed.stripeCustomerId, parsed.metadataUserId, database);
    if (!userId) throw new BillingMappingError(missingMessage);
    return userId;
  }

  async deleteCustomerForAccount(userId: string): Promise<void> {
    const customerId = await this.billing.customerForUser(userId);
    if (!customerId) return;
    this.requireEnabled('Complete account erasure is temporarily unavailable because Stripe billing is disabled.');
    try {
      await this.stripe.deleteCustomer(customerId, `histae-delete-customer-${userId}`);
    } catch (error) {
      throw apiError(503, 'data_erasure_unavailable', 'The Stripe customer could not be erased at this time.', error);
    }
  }

  private parseSubscription(subscription: Stripe.Subscription): ParsedSubscription {
    const status = subscription.status;
    if (!STRIPE_SUBSCRIPTION_STATUSES.includes(status as StripeSubscriptionStatus)) {
      throw new BillingMappingError(`Unsupported Stripe subscription status: ${status}`);
    }
    if (subscription.items.data.length !== 1) throw new BillingMappingError('Histae subscriptions must contain exactly one Stripe Price');
    const item = subscription.items.data[0]!;
    const priceId = item.price.id;
    const productId = objectId(item.price.product);
    if (productId !== this.config.billing.premiumProductId) throw new BillingMappingError('Stripe subscription does not use the configured Premium product');
    const billingPeriod = this.periodForPrice(priceId);
    const metadataUserId = subscription.metadata.histae_user_id;
    return {
      metadataUserId: typeof metadataUserId === 'string' && isUUID(metadataUserId, 'all') ? metadataUserId : null,
      stripeCustomerId: customerId(subscription.customer),
      stripeSubscriptionId: subscription.id,
      stripePriceId: priceId,
      billingPeriod,
      status: status as StripeSubscriptionStatus,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      currentPeriodStartsAt: new Date(item.current_period_start * 1_000),
      currentPeriodEndsAt: new Date(item.current_period_end * 1_000),
      trialStartsAt: unixDate(subscription.trial_start),
      trialEndsAt: unixDate(subscription.trial_end),
      canceledAt: unixDate(subscription.canceled_at),
    };
  }

  private parseInvoice(invoice: Stripe.Invoice, eventCreatedAt: Date): InvoiceProjection {
    return {
      stripeInvoiceId: invoice.id,
      stripeCustomerId: customerId(invoice.customer),
      stripeSubscriptionId: subscriptionIdForInvoice(invoice),
      status: invoice.status,
      currency: invoice.currency.toUpperCase(),
      amountDue: invoice.amount_due,
      amountPaid: invoice.amount_paid,
      amountRemaining: invoice.amount_remaining,
      periodStartsAt: new Date(invoice.period_start * 1_000),
      periodEndsAt: new Date(invoice.period_end * 1_000),
      paidAt: unixDate(invoice.status_transitions.paid_at),
      createdAt: new Date(invoice.created * 1_000),
      eventCreatedAt,
    };
  }

  private periodForPrice(priceId: string): BillingPeriod {
    if (priceId === this.config.billing.premiumMonthlyPriceId) return 'monthly';
    if (priceId === this.config.billing.premiumAnnualPriceId) return 'annual';
    throw new BillingMappingError('Stripe subscription uses an unknown Price');
  }

  private async deliverBillingEffect(effect: WebhookEffect): Promise<void> {
    try {
      if (effect.subscriptionStatus) await this.delivery.subscriptionUpdated(effect.userId, effect.subscriptionStatus);
      if (effect.paymentFailed) await this.delivery.billingPaymentFailed(effect.userId);
      if (effect.trialEnding) await this.delivery.subscriptionTrialEnding(effect.userId);
    } catch (error) {
      this.logger.warn(`Billing notification delivery failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  private async expireBestEffort(sessionId: string): Promise<void> {
    try {
      await this.stripe.expireCheckoutSession(sessionId);
    } catch (error) {
      this.logger.warn(`Could not expire an orphaned Stripe Checkout session: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  private async deleteCustomerBestEffort(customerId: string, attemptId: string): Promise<void> {
    try {
      await this.stripe.deleteCustomer(customerId, `histae-delete-orphan-${attemptId}`);
    } catch (error) {
      this.logger.warn(`Could not delete an orphaned Stripe Customer: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  private requireEnabled(message = 'Stripe billing is temporarily unavailable.'): void {
    if (!this.enabled) throw apiError(503, 'billing_unavailable', message);
  }

  private get enabled(): boolean {
    return this.config.billing.provider === 'stripe';
  }

  private providerError(error: unknown): ApiError {
    return apiError(503, 'stripe_request_failed', 'Stripe could not process the billing request at this time.', error);
  }
}

function unixDate(value: number | null): Date | null {
  return value === null ? null : new Date(value * 1_000);
}

function objectId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string') return value.id;
  return null;
}

function customerId(value: Stripe.Subscription['customer'] | Stripe.Invoice['customer']): string {
  const id = objectId(value);
  if (!id) throw new BillingMappingError('Stripe object has no customer ID');
  return id;
}

function subscriptionIdForInvoice(invoice: Stripe.Invoice): string | null {
  return objectId(invoice.parent?.subscription_details?.subscription);
}
