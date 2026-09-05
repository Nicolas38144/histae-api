import { Injectable, Logger } from '@nestjs/common';
import type Stripe from 'stripe';
import { apiError } from '../common/api-error';
import { ConfigService } from '../config/config.service';
import type { Queryable } from '../database/database.service';
import { MobileDeliveryService } from '../mobile/mobile-delivery.service';
import { enqueueNotification } from '../mobile/notification-outbox';
import type { BillingNotificationIntent } from '../mobile/notification-billing';
import type { StripeSubscriptionStatus, WebhookMetadata } from './billing.models';
import { BillingAccountInactiveError, BillingMappingError } from './billing.errors';
import { BillingRepository } from './billing.repository';
import { StripeGateway } from './stripe.gateway';
import {
  StripeProjectionMapper,
  stripeCustomerId,
  stripeObjectId,
  stripeSubscriptionIdForInvoice,
  type ParsedSubscription,
} from './stripe-projection.mapper';

const SUBSCRIPTION_EVENT_TYPES = new Set<string>([
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'customer.subscription.paused', 'customer.subscription.resumed', 'customer.subscription.trial_will_end',
]);
const INVOICE_EVENT_TYPES = new Set<string>([
  'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.finalization_failed',
]);
const CHECKOUT_EVENT_TYPES = new Set<string>(['checkout.session.completed', 'checkout.session.expired']);
const SUPPORTED_WEBHOOK_EVENT_TYPES = new Set<string>([
  ...SUBSCRIPTION_EVENT_TYPES, ...INVOICE_EVENT_TYPES, ...CHECKOUT_EVENT_TYPES, 'customer.deleted',
]);

type WebhookEffect = {
  userId: string;
  notification?: BillingNotificationIntent;
  subscriptionStatus?: StripeSubscriptionStatus;
};
@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);
  private readonly projections: StripeProjectionMapper;

  constructor(
    private readonly billing: BillingRepository,
    private readonly stripe: StripeGateway,
    private readonly config: ConfigService,
    private readonly delivery: MobileDeliveryService,
  ) {
    this.projections = new StripeProjectionMapper(config.billing);
  }

  async handle(rawBody: Buffer | undefined, signature: string | undefined): Promise<void> {
    const event = this.verifiedEvent(rawBody, signature);
    if (!SUPPORTED_WEBHOOK_EVENT_TYPES.has(event.type) || await this.billing.webhookProcessed(event.id)) return;
    const invoice = INVOICE_EVENT_TYPES.has(event.type) ? event.data.object as Stripe.Invoice : undefined;
    const prefetchedSubscription = invoice ? await this.subscriptionForInvoice(invoice) : undefined;
    const metadata: WebhookMetadata = {
      id: event.id, type: event.type, objectId: stripeObjectId(event.data.object), livemode: event.livemode,
      apiVersion: event.api_version, createdAt: new Date(event.created * 1_000),
    };
    let processed: { duplicate: boolean; result?: WebhookEffect };
    try {
      processed = await this.billing.processWebhook(
        metadata,
        async (database) => {
          let effect: WebhookEffect | undefined;
          try { effect = await this.processEvent(event, metadata, invoice, prefetchedSubscription, database); }
          catch (error) {
            // Commit the webhook receipt, without recreating data for an erased account.
            if (error instanceof BillingAccountInactiveError) return undefined;
            throw error;
          }
          if (effect?.notification) {
            await enqueueNotification(database, effect.userId, event.id, effect.notification);
          }
          return effect;
        },
      );
    } catch (error) {
      if (error instanceof BillingMappingError) throw apiError(400, 'invalid_stripe_event', error.message, error);
      throw error;
    }
    if (!processed.duplicate && processed.result) await this.deliverEffect(processed.result);
  }

  private verifiedEvent(rawBody: Buffer | undefined, signature: string | undefined): Stripe.Event {
    if (this.config.billing.provider !== 'stripe') throw apiError(503, 'billing_unavailable', 'Stripe billing is temporarily unavailable.');
    if (!rawBody || !signature) throw apiError(400, 'invalid_stripe_signature', 'A signed raw Stripe webhook body is required.');
    let event: Stripe.Event;
    try { event = this.stripe.constructWebhookEvent(rawBody, signature); }
    catch (error) { throw apiError(400, 'invalid_stripe_signature', 'The Stripe webhook signature is invalid.', error); }
    if (event.livemode !== this.config.billing.stripeSecretKey.startsWith('sk_live_')) {
      throw apiError(400, 'stripe_mode_mismatch', 'The Stripe webhook event does not match the configured billing mode.');
    }
    return event;
  }

  private async subscriptionForInvoice(invoice: Stripe.Invoice): Promise<ParsedSubscription | undefined> {
    const subscriptionId = stripeSubscriptionIdForInvoice(invoice);
    if (!subscriptionId) return undefined;
    try { return this.projections.subscription(await this.stripe.retrieveSubscription(subscriptionId)); }
    catch (error) {
      if (error instanceof BillingMappingError) throw apiError(400, 'invalid_stripe_event', error.message, error);
      throw apiError(503, 'stripe_request_failed', 'Stripe could not process the billing request at this time.', error);
    }
  }

  private async processEvent(
    event: Stripe.Event,
    metadata: WebhookMetadata,
    invoice: Stripe.Invoice | undefined,
    prefetchedSubscription: ParsedSubscription | undefined,
    database: Queryable,
  ): Promise<WebhookEffect | undefined> {
    if (SUBSCRIPTION_EVENT_TYPES.has(event.type)) {
      const parsed = this.projections.subscription(event.data.object as Stripe.Subscription);
      const userId = await this.resolveUser(parsed, database, 'Stripe subscription has no Histae customer mapping');
      await this.billing.upsertSubscription({ ...parsed, userId, eventCreatedAt: metadata.createdAt }, database);
      return {
        userId, subscriptionStatus: parsed.status,
        notification: event.type === 'customer.subscription.trial_will_end' && parsed.trialEndsAt
          ? { type: 'subscription_trial_ending', subscriptionId: parsed.stripeSubscriptionId, trialEndsAt: parsed.trialEndsAt }
          : undefined,
      };
    }
    if (invoice && prefetchedSubscription) {
      if (prefetchedSubscription.stripeCustomerId !== stripeCustomerId(invoice.customer)) {
        throw new BillingMappingError('Stripe invoice customer does not own its subscription');
      }
      const userId = await this.resolveUser(prefetchedSubscription, database, 'Stripe invoice has no Histae customer mapping');
      await this.billing.upsertSubscription({ ...prefetchedSubscription, userId, eventCreatedAt: metadata.createdAt }, database);
      await this.billing.upsertInvoice(userId, this.projections.invoice(invoice, metadata.createdAt), database);
      return {
        userId, subscriptionStatus: prefetchedSubscription.status,
        notification: event.type === 'invoice.payment_failed' || event.type === 'invoice.payment_action_required'
          ? { type: 'billing_payment_failed', invoiceId: invoice.id } : undefined,
      };
    }
    if (CHECKOUT_EVENT_TYPES.has(event.type)) {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = await this.billing.markCheckoutFromWebhook(
        session.id, event.type === 'checkout.session.completed' ? 'completed' : 'expired', database,
      );
      return userId ? { userId } : undefined;
    }
    if (event.type === 'customer.deleted') {
      const deletedCustomerId = stripeObjectId(event.data.object);
      if (!deletedCustomerId) throw new BillingMappingError('Stripe Customer deletion has no object ID');
      const userId = await this.billing.markCustomerDeleted(deletedCustomerId, metadata.createdAt, database);
      return userId ? { userId, subscriptionStatus: 'canceled' } : undefined;
    }
    return undefined;
  }

  private async resolveUser(parsed: ParsedSubscription, database: Queryable, message: string): Promise<string> {
    const userId = await this.billing.resolveBillingUser(parsed.stripeCustomerId, parsed.metadataUserId, database);
    if (!userId) throw new BillingMappingError(message);
    return userId;
  }

  private async deliverEffect(effect: WebhookEffect): Promise<void> {
    try {
      if (effect.subscriptionStatus) await this.delivery.subscriptionUpdated(effect.userId, effect.subscriptionStatus);
    } catch {
      this.logger.warn('billing_realtime_delivery_failed');
    }
  }
}
