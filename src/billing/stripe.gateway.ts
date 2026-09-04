import { Injectable, Optional } from '@nestjs/common';
import Stripe from 'stripe';
import { ConfigService } from '../config/config.service';
import type { BillingPeriod } from './billing.models';
import { OperationalMetricsService } from '../operations/operational-metrics.service';

type CheckoutInput = {
  userId: string;
  customerId: string;
  priceId: string;
  billingPeriod: BillingPeriod;
  trialDays: number;
  expiresAt: Date;
  idempotencyKey: string;
};

@Injectable()
export class StripeGateway {
  private readonly client: Stripe | undefined;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly metrics?: OperationalMetricsService,
  ) {
    if (config.billing.provider === 'stripe') {
      this.client = new Stripe(config.billing.stripeSecretKey, {
        appInfo: { name: 'histae-api', version: '3.0.0' },
        maxNetworkRetries: config.billing.maxNetworkRetries,
        timeout: config.billing.timeoutMillis,
      });
    }
  }

  constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
    const operation = () => this.requireClient().webhooks.constructEvent(rawBody, signature, this.config.billing.stripeWebhookSecret);
    return this.metrics?.measureSync('stripe', operation) ?? operation();
  }

  createCustomer(userId: string, idempotencyKey: string): Promise<Stripe.Customer> {
    return this.measure(this.requireClient().customers.create({
      description: 'Histae mobile subscriber',
      metadata: { histae_user_id: userId },
    }, { idempotencyKey }));
  }

  createCheckoutSession(input: CheckoutInput): Promise<Stripe.Checkout.Session> {
    const subscriptionData: Stripe.Checkout.SessionCreateParams.SubscriptionData = {
      metadata: {
        histae_user_id: input.userId,
        histae_plan: 'premium',
        histae_billing_period: input.billingPeriod,
      },
    };
    if (input.trialDays > 0) subscriptionData.trial_period_days = input.trialDays;
    return this.measure(this.requireClient().checkout.sessions.create({
      mode: 'subscription',
      origin_context: 'mobile_app',
      customer: input.customerId,
      client_reference_id: input.userId,
      line_items: [{ price: input.priceId, quantity: 1 }],
      metadata: {
        histae_user_id: input.userId,
        histae_plan: 'premium',
        histae_billing_period: input.billingPeriod,
      },
      subscription_data: subscriptionData,
      payment_method_collection: 'always',
      allow_promotion_codes: this.config.billing.allowPromotionCodes,
      automatic_tax: { enabled: this.config.billing.automaticTax },
      billing_address_collection: this.config.billing.automaticTax ? 'required' : 'auto',
      success_url: this.config.billing.checkoutSuccessUrl,
      cancel_url: this.config.billing.checkoutCancelUrl,
      expires_at: Math.floor(input.expiresAt.getTime() / 1_000),
    }, { idempotencyKey: input.idempotencyKey }));
  }

  expireCheckoutSession(sessionId: string): Promise<Stripe.Checkout.Session> {
    return this.measure(this.requireClient().checkout.sessions.expire(sessionId));
  }

  createPortalSession(customerId: string, idempotencyKey: string): Promise<Stripe.BillingPortal.Session> {
    return this.measure(this.requireClient().billingPortal.sessions.create({
      customer: customerId,
      return_url: this.config.billing.portalReturnUrl,
    }, { idempotencyKey }));
  }

  retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription> {
    return this.measure(this.requireClient().subscriptions.retrieve(subscriptionId));
  }

  deleteCustomer(customerId: string, idempotencyKey: string): Promise<Stripe.DeletedCustomer> {
    return this.measure(this.requireClient().customers.del(customerId, {}, { idempotencyKey }));
  }

  retrieveCustomer(customerId: string): Promise<Stripe.Customer | Stripe.DeletedCustomer> {
    return this.measure(this.requireClient().customers.retrieve(customerId));
  }

  private requireClient(): Stripe {
    if (!this.client) throw new Error('Stripe billing is disabled');
    return this.client;
  }

  private measure<T>(operation: Promise<T>): Promise<T> {
    return this.metrics?.measure('stripe', () => operation) ?? operation;
  }
}
