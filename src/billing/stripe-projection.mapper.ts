import { isUUID } from 'class-validator';
import type Stripe from 'stripe';

import type { BillingConfig } from '../config/config.service';
import { BillingMappingError } from './billing.errors';
import type {
  BillingPeriod,
  InvoiceProjection,
  StripeSubscriptionStatus,
  SubscriptionProjection,
} from './billing.models';
import { STRIPE_SUBSCRIPTION_STATUSES } from './billing.models';

export type ParsedSubscription = Omit<SubscriptionProjection, 'userId' | 'eventCreatedAt'> & {
  metadataUserId: string | null;
};

export class StripeProjectionMapper {
  constructor(private readonly config: BillingConfig) {}

  subscription(subscription: Stripe.Subscription): ParsedSubscription {
    if (!STRIPE_SUBSCRIPTION_STATUSES.includes(subscription.status as StripeSubscriptionStatus)) {
      throw new BillingMappingError(`Unsupported Stripe subscription status: ${subscription.status}`);
    }
    if (subscription.items.data.length !== 1) {
      throw new BillingMappingError('Histae subscriptions must contain exactly one Stripe Price');
    }
    const item = subscription.items.data[0]!;
    if (stripeObjectId(item.price.product) !== this.config.premiumProductId) {
      throw new BillingMappingError('Stripe subscription does not use the configured Premium product');
    }
    const metadataUserId = subscription.metadata.histae_user_id;
    return {
      metadataUserId: typeof metadataUserId === 'string' && isUUID(metadataUserId, 'all') ? metadataUserId : null,
      stripeCustomerId: stripeCustomerId(subscription.customer),
      stripeSubscriptionId: subscription.id,
      stripePriceId: item.price.id,
      billingPeriod: this.periodForPrice(item.price.id),
      status: subscription.status as StripeSubscriptionStatus,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      currentPeriodStartsAt: new Date(item.current_period_start * 1_000),
      currentPeriodEndsAt: new Date(item.current_period_end * 1_000),
      trialStartsAt: unixDate(subscription.trial_start),
      trialEndsAt: unixDate(subscription.trial_end),
      canceledAt: unixDate(subscription.canceled_at),
    };
  }

  invoice(invoice: Stripe.Invoice, eventCreatedAt: Date): InvoiceProjection {
    return {
      stripeInvoiceId: invoice.id,
      stripeCustomerId: stripeCustomerId(invoice.customer),
      stripeSubscriptionId: stripeSubscriptionIdForInvoice(invoice),
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
    if (priceId === this.config.premiumMonthlyPriceId) return 'monthly';
    if (priceId === this.config.premiumAnnualPriceId) return 'annual';
    throw new BillingMappingError('Stripe subscription uses an unknown Price');
  }
}

export function stripeObjectId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string'
    ? value.id
    : null;
}

export function stripeCustomerId(value: Stripe.Subscription['customer'] | Stripe.Invoice['customer']): string {
  const id = stripeObjectId(value);
  if (!id) throw new BillingMappingError('Stripe object has no customer ID');
  return id;
}

export function stripeSubscriptionIdForInvoice(invoice: Stripe.Invoice): string | null {
  return stripeObjectId(invoice.parent?.subscription_details?.subscription);
}

function unixDate(value: number | null): Date | null {
  return value === null ? null : new Date(value * 1_000);
}
