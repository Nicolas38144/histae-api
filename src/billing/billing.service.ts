import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiError, apiError } from '../common/api-error';
import { normalizeIdempotencyKey } from '../common/idempotency';
import { ConfigService } from '../config/config.service';
import type {
  BillingPeriod,
  CheckoutSessionView,
  StripeSubscriptionStatus,
  SubscriptionView,
} from './billing.models';
import { BillingRepository } from './billing.repository';
import { StripeGateway } from './stripe.gateway';
import { CUSTOMER_CREATE_IDEMPOTENCY_SAFETY_MILLIS } from './billing.constants';
import { AccountActivityService, type AssertActivity } from '../database/account-activity.service';
import type { CustomerCreation } from './billing.repository';

const CHECKOUT_TTL_MILLIS = 30 * 60_000;
const CHECKOUT_CREATION_STALE_MILLIS = 60_000;
const PREMIUM_ACCESS_STATUSES = new Set<StripeSubscriptionStatus>(['trialing', 'active', 'past_due']);
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly billing: BillingRepository,
    private readonly stripe: StripeGateway,
    private readonly config: ConfigService,
    private readonly activity: AccountActivityService,
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
    return this.activity.run([userId], (assertHeld) => this.createCheckoutWhileActive(userId, billingPeriod, suppliedKey, assertHeld));
  }

  private async createCheckoutWhileActive(userId: string, billingPeriod: BillingPeriod, suppliedKey: string | undefined, assertHeld: AssertActivity): Promise<CheckoutSessionView> {
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
    if (attempt.state === 'customer_reconciliation_required') {
      throw apiError(409, 'billing_customer_reconciliation_required', 'An earlier Stripe customer creation must be resolved before starting another Checkout.');
    }
    if (attempt.state === 'idempotency_conflict') throw apiError(409, 'idempotency_key_reused', 'This Idempotency-Key was already used with a different billing period.');
    if (attempt.state === 'idempotency_consumed') throw apiError(409, 'idempotency_key_consumed', 'This Idempotency-Key belongs to a completed or expired Checkout session.');

    let createdSessionId: string | undefined;
    let unattachedCustomerId: string | undefined;
    try {
      let customerId = attempt.stripeCustomerId;
      if (!customerId) {
        const creation = await this.billing.beginCustomerCreation(attempt.attemptId);
        assertHeld();
        customerId = await this.resolveCustomerCreation(userId, creation);
        unattachedCustomerId = customerId;
        if (!await this.billing.saveCustomer(userId, customerId)) {
          throw apiError(409, 'billing_customer_conflict', 'The Stripe customer could not be attached to this account.');
        }
        unattachedCustomerId = undefined;
      }
      assertHeld();
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

  async deleteCustomerForAccount(userId: string): Promise<boolean> {
    const creations = await this.billing.customerCreationsForErasure(userId);
    const customerId = await this.billing.customerForUser(userId);
    if (!customerId && creations.length === 0) return true;
    this.requireEnabled('Complete account erasure is temporarily unavailable because Stripe billing is disabled.');
    try {
      for (const creation of creations) {
        const createdId = await this.resolveCustomerCreation(userId, creation);
        await this.deleteCustomerConfirmed(createdId, `histae-delete-orphan-${creation.id}`);
        await this.billing.markCreatedCustomerErased(creation.id);
      }
      if (creations.length === 50) return false;
      if (customerId) await this.deleteCustomerConfirmed(customerId, `histae-delete-customer-${userId}`);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'erasure_stripe_reconciliation_required') throw error;
      throw apiError(503, 'data_erasure_unavailable', 'The Stripe customer could not be erased at this time.', error);
    }
  }

  private async resolveCustomerCreation(userId: string, creation: CustomerCreation): Promise<string> {
    if (creation.customer_erased_at) throw apiError(409, 'idempotency_key_consumed', 'This customer creation has already been erased.');
    if (creation.created_customer_id) return creation.created_customer_id;
    // Stripe retains POST idempotency for at least 24h. Keep a safety margin;
    // beyond this window, replay could create a second customer. Fail closed.
    if (Date.now() - creation.customer_creation_started_at.getTime() >= CUSTOMER_CREATE_IDEMPOTENCY_SAFETY_MILLIS) {
      throw apiError(503, 'erasure_stripe_reconciliation_required', 'The Stripe customer creation requires reconciliation.');
    }
    const customer = await this.stripe.createCustomer(userId, creation.id, `histae-customer-${creation.id}`);
    await this.billing.recordCreatedCustomer(creation.id, customer.id);
    return customer.id;
  }

  private async expireBestEffort(sessionId: string): Promise<void> {
    try {
      await this.stripe.expireCheckoutSession(sessionId);
    } catch {
      this.logger.warn('stripe_orphan_checkout_expiry_failed');
    }
  }

  private async deleteCustomerBestEffort(customerId: string, attemptId: string): Promise<void> {
    try {
      await this.deleteCustomerConfirmed(customerId, `histae-delete-orphan-${attemptId}`);
      await this.billing.markCreatedCustomerErased(attemptId);
    } catch {
      this.logger.warn('stripe_orphan_customer_deletion_failed');
    }
  }

  private async deleteCustomerConfirmed(customerId: string, key: string): Promise<void> {
    try {
      await this.stripe.deleteCustomer(customerId, key);
    } catch (error) {
      // A generic 404 or network error is not proof. Stripe retains a retrievable
      // deleted-customer marker: verify its identity and deletion explicitly.
      try {
        const customer = await this.stripe.retrieveCustomer(customerId);
        if (customer.id === customerId && customer.deleted === true) return;
      } catch { /* Keep the original failed deletion retryable. */ }
      throw error;
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
