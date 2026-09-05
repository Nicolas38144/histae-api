export const BILLING_PERIODS = ['monthly', 'annual'] as const;
export type BillingPeriod = typeof BILLING_PERIODS[number];

export const STRIPE_SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const;
export type StripeSubscriptionStatus = typeof STRIPE_SUBSCRIPTION_STATUSES[number];

export type SubscriptionRow = {
  plan: string;
  provider: 'stripe' | null;
  provider_subscription_id: string | null;
  provider_price_id: string | null;
  billing_period: BillingPeriod | null;
  status: StripeSubscriptionStatus | null;
  cancel_at_period_end: boolean;
  current_period_starts_at: Date | null;
  current_period_ends_at: Date | null;
  trial_ends_at: Date | null;
  canceled_at: Date | null;
  updated_at: Date;
  stripe_customer_id: string | null;
  projection_version: number;
  provider_snapshot_at: Date | null;
};

export type SubscriptionView = {
  plan: 'free' | 'premium';
  provider: 'stripe' | null;
  status: StripeSubscriptionStatus | null;
  access_granted: boolean;
  billing_period: BillingPeriod | null;
  cancel_at_period_end: boolean;
  current_period_starts_at: Date | null;
  current_period_ends_at: Date | null;
  trial_ends_at: Date | null;
  canceled_at: Date | null;
  customer_portal_available: boolean;
};

export type CheckoutSessionView = {
  session_id: string;
  url: string;
  expires_at: Date;
};

export type SubscriptionProjection = {
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  billingPeriod: BillingPeriod;
  status: StripeSubscriptionStatus;
  cancelAtPeriodEnd: boolean;
  currentPeriodStartsAt: Date;
  currentPeriodEndsAt: Date;
  trialStartsAt: Date | null;
  trialEndsAt: Date | null;
  canceledAt: Date | null;
  eventCreatedAt: Date;
};

export type InvoiceProjection = {
  stripeInvoiceId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  status: string | null;
  currency: string;
  amountDue: number;
  amountPaid: number;
  amountRemaining: number;
  periodStartsAt: Date;
  periodEndsAt: Date;
  paidAt: Date | null;
  createdAt: Date;
  eventCreatedAt: Date;
};

export type WebhookMetadata = {
  id: string;
  type: string;
  objectId: string | null;
  livemode: boolean;
  apiVersion: string | null;
  createdAt: Date;
};

export const BILLING_RECONCILIATION_EVENT_TYPES = [
  'billing.subscription.reconcile',
  'billing.customer.reconcile',
] as const;
export type BillingReconciliationEventType = typeof BILLING_RECONCILIATION_EVENT_TYPES[number];

export type SubscriptionReconciliationContext = {
  userId: string;
  stripeCustomerId: string;
  projectionVersion: number | null;
};

export type CustomerCreationReconciliationContext = {
  attemptId: string;
  userId: string;
  startedAt: Date;
  createdCustomerId: string | null;
  mappedCustomerId: string | null;
  customerErasedAt: Date | null;
};

export type BillingReconciliationKind = 'subscription' | 'customer_creation';

export type BillingReconciliationRow = {
  id: string;
  user_id: string;
  kind: BillingReconciliationKind;
  attempts: number;
  last_error_code: string | null;
  created_at: Date;
  dead_lettered_at: Date;
  cursor_at: Date;
};

export type BillingReconciliationItem = {
  event_id: string;
  user_id: string;
  kind: BillingReconciliationKind;
  attempts: number;
  last_error_code: string | null;
  created_at: Date;
  dead_lettered_at: Date;
};
