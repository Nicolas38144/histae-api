import Stripe from 'stripe';
import { StripeGateway } from '../../../src/billing/stripe.gateway';

describe('StripeGateway webhook signatures', () => {
  it('accepts the exact raw payload signed with the configured endpoint secret', () => {
    const secret = 'whsec_histaeWebhookSecret';
    const payload = JSON.stringify({
      id: 'evt_HistaeSigned', object: 'event', type: 'customer.subscription.updated',
      livemode: false, api_version: '2026-07-29.dahlia', created: 1_899_000_000,
      data: { object: { id: 'sub_HistaeSubscription', object: 'subscription' } },
    });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp: Math.floor(Date.now() / 1_000) });
    const gateway = new StripeGateway({ billing: {
      provider: 'stripe',
      stripeSecretKey: 'sk_test_histaeSecret',
      stripeWebhookSecret: secret,
      maxNetworkRetries: 0,
      timeoutMillis: 1_000,
    } } as never);

    expect(gateway.constructWebhookEvent(Buffer.from(payload), signature)).toEqual(expect.objectContaining({
      id: 'evt_HistaeSigned',
      type: 'customer.subscription.updated',
    }));
    expect(() => gateway.constructWebhookEvent(Buffer.from(`${payload} `), signature)).toThrow();
  });
});
