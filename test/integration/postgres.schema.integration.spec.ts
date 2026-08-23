import * as dotenv from 'dotenv';
import type { PoolClient, PoolConfig } from 'pg';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../../src/app.module';
import { AuthRepository } from '../../src/auth/auth.repository';
import { AdminRepository } from '../../src/admin/admin.repository';
import { DiscoveryRepository } from '../../src/discovery/discovery.repository';
import { MatchesRepository } from '../../src/matches/matches.repository';
import type { MatchRow } from '../../src/matches/matches.models';
import { MatchesService } from '../../src/matches/matches.service';
import { PrivacyRepository } from '../../src/privacy/privacy.repository';
import { UsersRepository } from '../../src/users/users.repository';
import { BillingRepository } from '../../src/billing/billing.repository';

dotenv.config();
process.env.MAINTENANCE_MODE = 'disabled';
const poolConfig: PoolConfig = {
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  ssl: process.env.POSTGRES_SSLMODE !== 'disable',
};
if (process.env.ENV !== 'development' || process.env.POSTGRES_DB !== 'histae-dev') {
  throw new Error('PostgreSQL integration tests only allow ENV=development with POSTGRES_DB=histae-dev.');
}

describe('PostgreSQL schema contract', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool(poolConfig);
    await pool.query('SELECT 1');
  });

  afterAll(async () => pool.end());

  it('contains the tables required by the HTTP contract', async () => {
    const result = await pool.query<{ name: string | null }>(`
      SELECT to_regclass('public.' || name) AS name
      FROM unnest($1::text[]) AS name
    `, [[
      'user_account', 'otp_verification', 'refresh_tokens', 'user_profile', 'user_preferences',
      'match_init', 'match_state', 'chat_message', 'user_report', 'subscription_plan', 'user_consent',
      'data_subject_request', 'data_access_log', 'user_block', 'device_token', 'notification',
      'account_tombstone', 'account_deletion_token', 'billing_customer',
      'billing_checkout_session', 'stripe_webhook_event', 'billing_invoice',
    ]]);

    expect(result.rows.map((row) => row.name)).not.toContain(null);
  });

  it('calculates the Premium revenue estimate from the catalog price and selected period', async () => {
    const repository = new AdminRepository(databaseFor(pool) as never);
    const revenue = await repository.revenue('all_time');
    const expected = await pool.query<{ subscriptions: number; monthly_price_cents: number }>(`
      SELECT count(subscription.user_id)::int AS subscriptions,
        COALESCE(max(plan.monthly_price_cents), 0)::int AS monthly_price_cents
      FROM subscription_plan AS plan
      LEFT JOIN user_subscription AS subscription ON subscription.plan = plan.code
      WHERE plan.code = 'premium'
    `);
    const row = expected.rows[0] ?? { subscriptions: 0, monthly_price_cents: 0 };

    expect(revenue).toEqual(expect.objectContaining({
      period: 'all_time',
      premium_subscriptions: row.subscriptions,
      price_per_subscription_cents: row.monthly_price_cents,
      estimated_revenue_cents: row.subscriptions * row.monthly_price_cents,
      currency: 'EUR',
      basis: 'premium_monthly_price',
    }));
  });

  it('contains the useful indexes and excludes the ten redundant or obsolete indexes', async () => {
    const result = await pool.query<{ name: string | null }>(`
      SELECT to_regclass('public.' || name) AS name
      FROM unnest($1::text[]) AS name
    `, [[
      'idx_consent_active', 'idx_dsr_status', 'idx_dal_date',
      'idx_consent_event_sequence',
      'idx_user_presence_location', 'idx_match_state_user', 'idx_refresh_tokens_expires',
      'idx_user_block_blocked', 'idx_user_report_reported', 'idx_device_token_user',
      'idx_notification_expire', 'idx_otp_idempotency', 'idx_otp_one_usable_per_phone',
      'idx_dsr_one_open_per_type', 'idx_match_init_activity', 'idx_message_match_created_desc',
      'idx_user_report_created_desc', 'idx_user_report_status_created_desc',
      'idx_chat_message_sender_idempotency', 'idx_chat_message_match_unread',
      'idx_account_deletion_token_expires',
      'idx_user_subscription_provider_id', 'idx_billing_checkout_one_live_per_user',
      'idx_billing_checkout_expiry', 'idx_stripe_webhook_processed', 'idx_billing_invoice_user_created',
      'idx_billing_customer_active_stripe_id',
    ]]);

    expect(result.rows.map((row) => row.name)).not.toContain(null);
    const removed = await pool.query<{ name: string | null }>(`
      SELECT to_regclass('public.' || name) AS name
      FROM unnest($1::text[]) AS name
    `, [[
      'idx_user_account_phone_hash', 'idx_refresh_tokens_jti', 'idx_message_match_created',
      'idx_user_report_status', 'idx_consent_user', 'idx_match_init_last_message',
      'idx_user_account_active', 'idx_user_account_to_anon', 'idx_refresh_tokens_active',
      'idx_otp_phone_usable',
    ]]);
    expect(removed.rows.map((row) => row.name)).toEqual(Array(10).fill(null));

    const activeConsentIndex = await pool.query<{ is_unique: boolean }>(`
      SELECT index_definition.indisunique AS is_unique
      FROM pg_index AS index_definition
      WHERE index_definition.indexrelid = 'idx_consent_active'::regclass
    `);
    expect(activeConsentIndex.rows[0]?.is_unique).toBe(true);
    const usableOtpIndex = await pool.query<{ is_unique: boolean }>(`
      SELECT index_definition.indisunique AS is_unique
      FROM pg_index AS index_definition
      WHERE index_definition.indexrelid = 'idx_otp_one_usable_per_phone'::regclass
    `);
    expect(usableOtpIndex.rows[0]?.is_unique).toBe(true);
  });

  it('activates only provider-accepted OTPs and preserves an older code after delivery failure', async () => {
    const repository = new AuthRepository(databaseFor(pool) as never);
    const phoneHash = 'otp-test-' + randomUUID();
    const firstId = randomUUID();
    const firstKey = randomUUID();
    const failedId = randomUUID();
    try {
      await expect(repository.beginOtpDelivery({
        id: firstId,
        phoneHash,
        otpHash: 'first-hash',
        idempotencyKey: firstKey,
        expiresAt: new Date(Date.now() + 600_000),
        staleBefore: new Date(Date.now() - 15_000),
      })).resolves.toEqual({ state: 'created', id: firstId });
      await expect(repository.beginOtpDelivery({
        id: randomUUID(),
        phoneHash,
        otpHash: 'different-hash',
        idempotencyKey: firstKey,
        expiresAt: new Date(Date.now() + 600_000),
        staleBefore: new Date(Date.now() - 15_000),
      })).resolves.toEqual({ state: 'pending', id: firstId });
      await expect(repository.markOtpSent(firstId, phoneHash, 'transaction-1', 'message-1')).resolves.toBe(true);

      await expect(repository.beginOtpDelivery({
        id: failedId,
        phoneHash,
        otpHash: 'failed-hash',
        idempotencyKey: randomUUID(),
        expiresAt: new Date(Date.now() + 600_000),
        staleBefore: new Date(Date.now() - 15_000),
      })).resolves.toEqual({ state: 'created', id: failedId });
      await repository.markOtpFailed(failedId, 'provider_http_503');

      await expect(repository.consumeOtp(phoneHash, 'failed-hash')).resolves.toBe(false);
      await expect(repository.consumeOtp(phoneHash, 'first-hash')).resolves.toBe(true);
      const failed = await pool.query<{ delivery_status: string; delivery_error_code: string }>(
        'SELECT delivery_status, delivery_error_code FROM otp_verification WHERE id = $1',
        [failedId],
      );
      expect(failed.rows[0]).toEqual({ delivery_status: 'failed', delivery_error_code: 'provider_http_503' });
    } finally {
      await pool.query('DELETE FROM otp_verification WHERE phone_number_hash = $1', [phoneHash]);
    }
  });

  it('marks an abandoned pending OTP as a failed delivery on replay', async () => {
    const repository = new AuthRepository(databaseFor(pool) as never);
    const phoneHash = 'otp-stale-' + randomUUID();
    const id = randomUUID();
    const idempotencyKey = randomUUID();
    try {
      await expect(repository.beginOtpDelivery({
        id,
        phoneHash,
        otpHash: 'stale-hash',
        idempotencyKey,
        expiresAt: new Date(Date.now() + 600_000),
        staleBefore: new Date(Date.now() - 15_000),
      })).resolves.toEqual({ state: 'created', id });
      await pool.query("UPDATE otp_verification SET created_at = clock_timestamp() - INTERVAL '1 minute' WHERE id = $1", [id]);

      await expect(repository.beginOtpDelivery({
        id: randomUUID(),
        phoneHash,
        otpHash: 'replacement-hash',
        idempotencyKey,
        expiresAt: new Date(Date.now() + 600_000),
        staleBefore: new Date(),
      })).resolves.toEqual({ state: 'failed', id });
      const delivery = await pool.query<{ delivery_status: string; delivery_error_code: string }>(
        'SELECT delivery_status, delivery_error_code FROM otp_verification WHERE id = $1',
        [id],
      );
      expect(delivery.rows[0]).toEqual({ delivery_status: 'failed', delivery_error_code: 'delivery_unknown' });
    } finally {
      await pool.query('DELETE FROM otp_verification WHERE phone_number_hash = $1', [phoneHash]);
    }
  });

  it('keeps exactly one usable OTP when two provider acceptances complete concurrently', async () => {
    const repository = new AuthRepository(databaseFor(pool) as never);
    const phoneHash = 'otp-concurrent-' + randomUUID();
    const firstId = randomUUID();
    const secondId = randomUUID();
    try {
      for (const [id, otpHash] of [[firstId, 'first-hash'], [secondId, 'second-hash']] as const) {
        await expect(repository.beginOtpDelivery({
          id,
          phoneHash,
          otpHash,
          idempotencyKey: randomUUID(),
          expiresAt: new Date(Date.now() + 600_000),
          staleBefore: new Date(Date.now() - 15_000),
        })).resolves.toEqual({ state: 'created', id });
      }

      await expect(Promise.all([
        repository.markOtpSent(firstId, phoneHash, 'transaction-1', 'message-1'),
        repository.markOtpSent(secondId, phoneHash, 'transaction-2', 'message-2'),
      ])).resolves.toEqual([true, true]);
      const deliveries = await pool.query<{ delivery_status: string; used: boolean }>(`
        SELECT delivery_status, used FROM otp_verification WHERE phone_number_hash = $1
      `, [phoneHash]);
      expect(deliveries.rows.filter((row) => row.delivery_status === 'sent' && !row.used)).toHaveLength(1);
      expect(deliveries.rows.filter((row) => row.used)).toHaveLength(1);
    } finally {
      await pool.query('DELETE FROM otp_verification WHERE phone_number_hash = $1', [phoneHash]);
    }
  });

  it('executes every retention query against PostgreSQL', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const repository = new PrivacyRepository(databaseFor(pool) as never);
      await expect(repository.runMaintenance({ query: client.query.bind(client) } as never, new Date(), 100)).resolves.toEqual({
        stale_presences: expect.any(Number),
        expired_presences: expect.any(Number),
        expired_otps: expect.any(Number),
        expired_refresh_tokens: expect.any(Number),
        expired_notifications: expect.any(Number),
        expired_consents: expect.any(Number),
        expired_data_subject_requests: expect.any(Number),
        expired_data_access_logs: expect.any(Number),
        expired_reports: expect.any(Number),
        expired_account_tombstones: expect.any(Number),
        expired_account_deletion_tokens: expect.any(Number),
      });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('boots the complete Nest graph and emits request and response OpenAPI schemas', async () => {
    process.env.MAINTENANCE_MODE = 'disabled';
    const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
    try {
      await app.init();
      const document = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('test').setVersion('test').build());
      expect(document.paths['/api/users/me/consents']?.put?.requestBody).toEqual(expect.objectContaining({
        content: expect.objectContaining({
          'application/json': expect.objectContaining({ schema: { $ref: '#/components/schemas/UpdateConsentsDto' } }),
        }),
      }));
      expect(document.paths['/api/matches/me']?.get?.responses?.['200']).toEqual(expect.objectContaining({
        content: expect.objectContaining({
          'application/json': expect.objectContaining({ schema: { $ref: '#/components/schemas/UserMatchPageResponseDto' } }),
        }),
      }));
      expect(document.paths['/api/feed']?.get?.responses?.['200']).toBeDefined();
      expect(document.paths['/api/swipes']?.post?.requestBody).toBeDefined();
      expect(document.paths['/api/auth/otp/send']?.post?.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
      ]));
      expect(document.paths['/api/matches/{id}/messages']?.post?.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
      ]));
      expect(document.paths['/api/auth/me']?.get).toBeDefined();
      expect(document.paths['/api/users/me/traits']?.get).toBeDefined();
      expect(document.paths['/api/users/me/discovery-status']?.get).toBeDefined();
      expect(document.paths['/api/users/me/deletion-token']?.post).toBeDefined();
      expect(document.paths['/api/users/me/devices']?.post).toBeDefined();
      expect(document.paths['/api/users/me/events']?.get).toBeDefined();
      expect(document.paths['/api/users/me/subscription']?.get).toBeDefined();
      expect(document.paths['/api/users/me/subscription/checkout']?.post?.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
      ]));
      expect(document.paths['/api/users/me/subscription/portal']?.post).toBeDefined();
      expect(document.paths['/api/billing/stripe/webhook']?.post).toBeDefined();
      expect(document.paths['/api/fake-match']).toBeUndefined();
      expect(document.components?.schemas).toEqual(expect.objectContaining({
        ConsentStateResponseDto: expect.any(Object),
        FeedResponseDto: expect.any(Object),
        SwipeResponseDto: expect.any(Object),
        PortableDataResponseDto: expect.any(Object),
        ReportPageResponseDto: expect.any(Object),
        SubscriptionResponseDto: expect.any(Object),
        CheckoutSessionResponseDto: expect.any(Object),
      }));
    } finally {
      await app.close();
    }
  });

  it('accepts only the four supported legal choices and no marketing choice', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const userId = randomUUID();
      await client.query(`
        INSERT INTO user_account (user_id, role, phone_number_hash, phone_number_encrypted)
        VALUES ($1, 'user', $2, $3)
      `, [userId, `test-${userId}`, Buffer.alloc(0)]);
      await client.query(`
        INSERT INTO user_consent (user_id, consent_type, granted, document_version)
        SELECT $1, choice, true, 'test-v1'
        FROM unnest($2::text[]) AS choice
      `, [userId, [
        'terms_of_service_acceptance',
        'privacy_notice_acknowledgement',
        'sensitive_data_consent',
        'location_consent',
      ]]);

      await expect(client.query(`
        INSERT INTO user_consent (user_id, consent_type, granted, document_version)
        VALUES ($1, 'marketing', true, 'test-v1')
      `, [userId])).rejects.toThrow();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('records a Stripe webhook exactly once even when Stripe retries it', async () => {
    const repository = new BillingRepository(databaseFor(pool) as never);
    const eventId = `evt_${randomUUID().replaceAll('-', '')}`;
    const work = jest.fn().mockResolvedValue('applied');
    const metadata = {
      id: eventId,
      type: 'customer.subscription.updated',
      objectId: 'sub_HistaeIntegration',
      livemode: false,
      apiVersion: '2026-07-29.dahlia',
      createdAt: new Date(),
    };

    try {
      await expect(repository.processWebhook(metadata, work)).resolves.toEqual({ duplicate: false, result: 'applied' });
      await expect(repository.processWebhook(metadata, work)).resolves.toEqual({ duplicate: true });
      expect(work).toHaveBeenCalledTimes(1);
    } finally {
      await pool.query('DELETE FROM stripe_webhook_event WHERE id = $1', [eventId]);
    }
  });

  it('creates and replays one Checkout while blocking a second live session', async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const idempotencyKey = randomUUID();
    const attemptId = randomUUID();
    const compactId = userId.replaceAll('-', '');
    await insertAccounts(pool, userId, otherUserId);
    const repository = new BillingRepository(databaseFor(pool) as never);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 60_000);

    try {
      await expect(repository.beginCheckout(
        userId, idempotencyKey, 'monthly', attemptId, now, expiresAt, new Date(now.getTime() - 60_000),
      )).resolves.toEqual(expect.objectContaining({
        state: 'created', attemptId, stripeCustomerId: null, trialDays: 30, trialUsed: false,
      }));
      await expect(repository.saveCustomer(userId, `cus_${compactId}`)).resolves.toBe(true);
      const session = {
        session_id: `cs_test_${compactId}`,
        url: 'https://checkout.stripe.test/session',
        expires_at: expiresAt,
      };
      await expect(repository.markCheckoutOpen(attemptId, session)).resolves.toBe(true);
      await expect(repository.beginCheckout(
        userId, idempotencyKey, 'monthly', randomUUID(), now, expiresAt, new Date(now.getTime() - 60_000),
      )).resolves.toEqual({ state: 'replay', session });
      await expect(repository.beginCheckout(
        userId, randomUUID(), 'annual', randomUUID(), now, expiresAt, new Date(now.getTime() - 60_000),
      )).resolves.toEqual({ state: 'in_progress' });
    } finally {
      await deleteAccounts(pool, userId, otherUserId);
    }
  });

  it('does not let an older Stripe event overwrite a newer subscription projection', async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const compactId = userId.replaceAll('-', '');
    const invoiceId = `in_order${compactId}`;
    const repository = new BillingRepository(databaseFor(pool) as never);
    const base = {
      userId,
      stripeCustomerId: `cus_${compactId}`,
      stripeSubscriptionId: `sub_${compactId}`,
      stripePriceId: `price_${compactId}`,
      billingPeriod: 'monthly' as const,
      cancelAtPeriodEnd: false,
      currentPeriodStartsAt: new Date('2030-01-01T00:00:00.000Z'),
      currentPeriodEndsAt: new Date('2030-02-01T00:00:00.000Z'),
      trialStartsAt: null,
      trialEndsAt: null,
      canceledAt: null,
    };
    await insertAccounts(pool, userId, otherUserId);
    await repository.saveCustomer(userId, base.stripeCustomerId);

    try {
      await repository.upsertSubscription({
        ...base, status: 'active', eventCreatedAt: new Date('2030-01-02T00:00:00.000Z'),
      }, databaseFor(pool));
      await repository.upsertSubscription({
        ...base, status: 'canceled', eventCreatedAt: new Date('2030-01-01T00:00:00.000Z'),
      }, databaseFor(pool));

      const projection = await pool.query<{ status: string; provider_event_created_at: Date }>(`
        SELECT status, provider_event_created_at FROM user_subscription WHERE user_id = $1
      `, [userId]);
      expect(projection.rows[0]).toEqual({
        status: 'active', provider_event_created_at: new Date('2030-01-02T00:00:00.000Z'),
      });

      const invoice = {
        stripeInvoiceId: invoiceId,
        stripeCustomerId: base.stripeCustomerId,
        stripeSubscriptionId: base.stripeSubscriptionId,
        currency: 'EUR',
        amountDue: 500,
        periodStartsAt: base.currentPeriodStartsAt,
        periodEndsAt: base.currentPeriodEndsAt,
        createdAt: new Date('2030-01-01T00:00:00.000Z'),
      };
      await repository.upsertInvoice(userId, {
        ...invoice,
        status: 'paid',
        amountPaid: 500,
        amountRemaining: 0,
        paidAt: new Date('2030-01-02T00:00:00.000Z'),
        eventCreatedAt: new Date('2030-01-02T00:00:00.000Z'),
      }, databaseFor(pool));
      await repository.upsertInvoice(userId, {
        ...invoice,
        status: 'open',
        amountPaid: 0,
        amountRemaining: 500,
        paidAt: null,
        eventCreatedAt: new Date('2030-01-01T00:00:00.000Z'),
      }, databaseFor(pool));
      await repository.upsertInvoice(userId, {
        ...invoice,
        status: 'open',
        amountPaid: 0,
        amountRemaining: 500,
        paidAt: null,
        eventCreatedAt: new Date('2030-01-02T00:00:00.000Z'),
      }, databaseFor(pool));
      const storedInvoice = await pool.query<{ status: string; provider_event_created_at: Date }>(`
        SELECT status, provider_event_created_at FROM billing_invoice WHERE stripe_invoice_id = $1
      `, [invoiceId]);
      expect(storedInvoice.rows[0]).toEqual({
        status: 'paid', provider_event_created_at: new Date('2030-01-02T00:00:00.000Z'),
      });
    } finally {
      await pool.query('DELETE FROM billing_invoice WHERE stripe_invoice_id = $1', [invoiceId]);
      await deleteAccounts(pool, userId, otherUserId);
    }
  });

  it('preserves consumed trial history when replacing a deleted Stripe Customer', async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const compactId = userId.replaceAll('-', '');
    const repository = new BillingRepository(databaseFor(pool) as never);
    const deletedCustomerId = `cus_deleted${compactId}`;
    const replacementCustomerId = `cus_replacement${compactId}`;
    const trialUsedAt = new Date('2029-12-01T00:00:00.000Z');
    await insertAccounts(pool, userId, otherUserId);
    await pool.query(`
      INSERT INTO billing_customer (user_id, stripe_customer_id, trial_used_at)
      VALUES ($1, $2, $3)
    `, [userId, deletedCustomerId, trialUsedAt]);

    try {
      await expect(repository.markCustomerDeleted(
        deletedCustomerId, new Date('2030-01-01T00:00:00.000Z'), databaseFor(pool),
      )).resolves.toBe(userId);
      await expect(repository.customerForUser(userId)).resolves.toBeUndefined();
      const now = new Date();
      await expect(repository.beginCheckout(
        userId, randomUUID(), 'monthly', randomUUID(), now,
        new Date(now.getTime() + 30 * 60_000), new Date(now.getTime() - 60_000),
      )).resolves.toEqual(expect.objectContaining({
        state: 'created', stripeCustomerId: null, trialUsed: true,
      }));
      await expect(repository.saveCustomer(userId, replacementCustomerId)).resolves.toBe(true);
      const customer = await pool.query<{
        stripe_customer_id: string;
        stripe_customer_deleted_at: Date | null;
        trial_used_at: Date;
      }>(`
        SELECT stripe_customer_id, stripe_customer_deleted_at, trial_used_at
        FROM billing_customer WHERE user_id = $1
      `, [userId]);
      expect(customer.rows[0]).toEqual({
        stripe_customer_id: replacementCustomerId,
        stripe_customer_deleted_at: null,
        trial_used_at: trialUsedAt,
      });
    } finally {
      await deleteAccounts(pool, userId, otherUserId);
    }
  });

  it('grants Premium only for entitled Stripe statuses within their current period', async () => {
    const [userId, otherUserId] = [randomUUID(), randomUUID()];
    await insertAccounts(pool, userId, otherUserId);
    const repository = new MatchesRepository(databaseFor(pool) as never);

    try {
      await pool.query(`
        INSERT INTO user_subscription (
          user_id, plan, provider, provider_subscription_id, provider_price_id,
          billing_period, status, current_period_ends_at, provider_event_created_at
        ) VALUES ($1, 'premium', 'stripe', $2, $3, 'monthly', 'active', clock_timestamp() + INTERVAL '1 month', clock_timestamp())
      `, [userId, `sub_${userId.replaceAll('-', '')}`, `price_${userId.replaceAll('-', '')}`]);
      await expect(repository.effectivePlan(userId, new Date())).resolves.toEqual({ plan: 'premium', weeklyLimit: null });

      await pool.query("UPDATE user_subscription SET status = 'canceled' WHERE user_id = $1", [userId]);
      await expect(repository.effectivePlan(userId, new Date())).resolves.toEqual({ plan: 'free', weeklyLimit: 3 });

      await pool.query("UPDATE user_subscription SET status = 'past_due', current_period_ends_at = clock_timestamp() - INTERVAL '1 second' WHERE user_id = $1", [userId]);
      await expect(repository.effectivePlan(userId, new Date())).resolves.toEqual({ plan: 'free', weeklyLimit: 3 });
    } finally {
      await deleteAccounts(pool, userId, otherUserId);
    }
  });

  it('serializes concurrent legal-choice writes and preserves their exact event order', async () => {
    const userId = randomUUID();
    await pool.query(`
      INSERT INTO user_account (user_id, role, phone_number_hash, phone_number_encrypted)
      VALUES ($1, 'user', $2, $3)
    `, [userId, `test-${userId}`, Buffer.alloc(0)]);
    const database = {
      query: pool.query.bind(pool),
      transaction: async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await work(client);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
    };
    const repository = new UsersRepository(database as never);

    try {
      await Promise.all([
        repository.recordConsents(userId, [{
          consent_type: 'sensitive_data_consent', granted: true, document_version: 'sensitive-a',
        }], '127.0.0.1', 'integration-a'),
        repository.recordConsents(userId, [{
          consent_type: 'sensitive_data_consent', granted: true, document_version: 'sensitive-b',
        }], '127.0.0.1', 'integration-b'),
      ]);

      const events = await pool.query<{ document_version: string; withdrawn_at: Date | null }>(`
        SELECT document_version, withdrawn_at
        FROM user_consent
        WHERE user_id = $1 AND consent_type = 'sensitive_data_consent'
        ORDER BY event_sequence
      `, [userId]);
      const active = events.rows.filter((event) => event.withdrawn_at === null);
      expect(events.rows).toHaveLength(2);
      expect(active).toHaveLength(1);
      expect(active[0]?.document_version).toBe(events.rows.at(-1)?.document_version);

      const current = await repository.currentConsents(userId);
      expect(current).toEqual([
        expect.objectContaining({
          consent_type: 'sensitive_data_consent',
          document_version: events.rows.at(-1)?.document_version,
          granted: true,
        }),
      ]);
    } finally {
      await pool.query('DELETE FROM user_account WHERE user_id = $1', [userId]);
    }
  });

  it('expires an awaiting match instead of failing its timestamp predicate', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const [firstUserId, secondUserId] = [randomUUID(), randomUUID()].sort();
      const matchId = randomUUID();
      const now = new Date('2030-01-07T12:00:00.000Z');
      await client.query(`
        INSERT INTO user_account (user_id, role, phone_number_hash, phone_number_encrypted)
        VALUES ($1, 'user', $2, $3), ($4, 'user', $5, $3)
      `, [firstUserId, `test-${firstUserId}`, Buffer.alloc(0), secondUserId, `test-${secondUserId}`]);
      await client.query(`
        INSERT INTO match_init (id, user1_id, user2_id, status, expires_at)
        VALUES ($1, $2, $3, 'awaiting_continuation', $4)
      `, [matchId, firstUserId, secondUserId, new Date(now.getTime() - 1_000)]);

      const repository = new MatchesRepository({ query: client.query.bind(client) } as never);
      await repository.expireAwaitingMatch(matchId, now);

      const result = await client.query<{ status: string; purge_after: Date }>(
        'SELECT status, purge_after FROM match_init WHERE id = $1',
        [matchId],
      );
      expect(result.rows[0]?.status).toBe('expired');
      expect(result.rows[0]?.purge_after.getTime()).toBe(now.getTime() + 30 * 24 * 60 * 60 * 1_000);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('does not expire an awaiting match whose continuation window is still open', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const [firstUserId, secondUserId] = [randomUUID(), randomUUID()].sort();
      const matchId = randomUUID();
      const now = new Date('2030-01-07T12:00:00.000Z');
      await insertAccounts(client, firstUserId, secondUserId);
      await client.query(`
        INSERT INTO match_init (id, user1_id, user2_id, status, expires_at)
        VALUES ($1, $2, $3, 'awaiting_continuation', $4)
      `, [matchId, firstUserId, secondUserId, new Date(now.getTime() + 60_000)]);

      const repository = new MatchesRepository({ query: client.query.bind(client) } as never);
      await repository.expireAwaitingMatch(matchId, now);

      const result = await client.query<{ status: string; purge_after: Date | null }>(
        'SELECT status, purge_after FROM match_init WHERE id = $1',
        [matchId],
      );
      expect(result.rows[0]).toEqual({ status: 'awaiting_continuation', purge_after: null });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('atomically refuses a message once an awaiting match has expired', async () => {
    const [firstUserId, secondUserId] = [randomUUID(), randomUUID()].sort();
    const matchId = randomUUID();
    await insertAccounts(pool, firstUserId, secondUserId);
    await pool.query(`
      INSERT INTO match_init (id, user1_id, user2_id, status, expires_at)
      VALUES ($1, $2, $3, 'awaiting_continuation', clock_timestamp() - INTERVAL '1 second')
    `, [matchId, firstUserId, secondUserId]);
    await pool.query(`
      INSERT INTO match_state (match_id, user_id) VALUES ($1, $2), ($1, $3)
    `, [matchId, firstUserId, secondUserId]);
    const repository = new MatchesRepository(databaseFor(pool) as never);

    try {
      await expect(repository.createMessage(randomUUID(), matchId, firstUserId, 'too late', randomUUID()))
        .resolves.toEqual({ ok: false, reason: 'expired' });
      const [match, messages] = await Promise.all([
        pool.query<{ status: string }>('SELECT status FROM match_init WHERE id = $1', [matchId]),
        pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM chat_message WHERE match_id = $1', [matchId]),
      ]);
      expect(match.rows[0]?.status).toBe('expired');
      expect(messages.rows[0]?.count).toBe(0);
    } finally {
      await deleteAccounts(pool, firstUserId, secondUserId);
    }
  });

  it('paginates PostgreSQL microseconds without skipping messages', async () => {
    const [firstUserId, secondUserId] = [randomUUID(), randomUUID()].sort();
    const matchId = randomUUID();
    await insertAccounts(pool, firstUserId, secondUserId);
    await pool.query(`
      INSERT INTO match_init (id, user1_id, user2_id, status, expires_at)
      VALUES ($1, $2, $3, 'active', clock_timestamp() + INTERVAL '1 day')
    `, [matchId, firstUserId, secondUserId]);
    await pool.query(`INSERT INTO match_state (match_id, user_id) VALUES ($1, $2), ($1, $3)`, [matchId, firstUserId, secondUserId]);
    await pool.query(`
      INSERT INTO chat_message (id, match_id, sender_id, content, created_at) VALUES
        ($1, $4, $5, 'newest', '2026-08-16T12:00:00.123900Z'),
        ($2, $4, $5, 'middle', '2026-08-16T12:00:00.123800Z'),
        ($3, $4, $5, 'oldest', '2026-08-16T12:00:00.123700Z')
    `, [randomUUID(), randomUUID(), randomUUID(), matchId, firstUserId]);
    const service = new MatchesService(new MatchesRepository(databaseFor(pool) as never));

    try {
      const firstPage = await service.getMessages(matchId, firstUserId, 1, 0);
      expect(firstPage.items.map((message) => message.content)).toEqual(['newest']);
      expect(firstPage.next_cursor).not.toBeNull();
      const secondPage = await service.getMessages(matchId, firstUserId, 1, 0, firstPage.next_cursor!);
      expect(secondPage.items.map((message) => message.content)).toEqual(['middle']);
      const thirdPage = await service.getMessages(matchId, firstUserId, 1, 0, secondPage.next_cursor!);
      expect(thirdPage.items.map((message) => message.content)).toEqual(['oldest']);
      expect(thirdPage.next_cursor).toBeNull();
    } finally {
      await deleteAccounts(pool, firstUserId, secondUserId);
    }
  });

  it('builds an eligible feed and excludes blocks and existing matches in PostgreSQL', async () => {
    const viewerId = randomUUID();
    const eligibleId = randomUUID();
    const blockedId = randomUUID();
    const [matchUser1, matchUser2] = [viewerId, eligibleId].sort();
    await insertAccounts(pool, viewerId, eligibleId);
    await pool.query(`
      INSERT INTO user_account (user_id, role, phone_number_hash, phone_number_encrypted)
      VALUES ($1, 'user', $2, $3)
    `, [blockedId, `test-${blockedId}`, Buffer.alloc(0)]);
    try {
      await pool.query(`
        INSERT INTO user_profile (user_id, firstname, birthdate, sex, bio)
        VALUES
          ($1, 'Viewer', '1990-01-01', 'male', 'viewer'),
          ($2, 'Eligible', '1992-01-01', 'female', 'eligible'),
          ($3, 'Blocked', '1993-01-01', 'female', 'blocked')
      `, [viewerId, eligibleId, blockedId]);
      await pool.query(`
        INSERT INTO user_preferences (user_id, min_age, max_age, max_distance_km, looking_for)
        VALUES ($1, 18, 99, 100, 'both'), ($2, 18, 99, 100, 'both'), ($3, 18, 99, 100, 'both')
      `, [viewerId, eligibleId, blockedId]);
      await pool.query(`
        INSERT INTO user_presence (user_id, latitude, longitude, is_location_fresh, updated_at)
        VALUES
          ($1, 48.856600, 2.352200, true, clock_timestamp()),
          ($2, 48.866600, 2.352200, true, clock_timestamp()),
          ($3, 48.876600, 2.352200, true, clock_timestamp())
      `, [viewerId, eligibleId, blockedId]);
      await pool.query(`
        INSERT INTO user_consent (user_id, consent_type, granted, document_version)
        SELECT users.user_id, choices.consent_type, true, 'test-v1'
        FROM unnest($1::uuid[]) AS users(user_id)
        CROSS JOIN unnest(ARRAY['sensitive_data_consent', 'location_consent']::text[]) AS choices(consent_type)
      `, [[viewerId, eligibleId, blockedId]]);
      await pool.query('INSERT INTO user_block (blocker_id, blocked_id) VALUES ($1, $2)', [blockedId, viewerId]);
      const repository = new DiscoveryRepository(databaseFor(pool) as never);

      await expect(repository.candidateBatch(viewerId, 'test-v1', 'test-v1', 20)).resolves.toEqual([
        expect.objectContaining({ user_id: eligibleId, firstname: 'Eligible', distance_km: expect.any(Number) }),
      ]);
      await expect(repository.isSwipeTargetAvailable(viewerId, blockedId, 'test-v1', 'test-v1')).resolves.toBe(false);

      await pool.query('INSERT INTO match_init (user1_id, user2_id) VALUES ($1, $2)', [matchUser1, matchUser2]);
      await expect(repository.candidateBatch(viewerId, 'test-v1', 'test-v1', 20)).resolves.toEqual([]);
      await expect(repository.isSwipeTargetAvailable(viewerId, eligibleId, 'test-v1', 'test-v1')).resolves.toBe(false);
    } finally {
      await deleteAccounts(pool, viewerId, eligibleId, blockedId);
    }
  });

  it('ends a match on block and prevents a new match for the same pair', async () => {
    const [firstUserId, secondUserId] = [randomUUID(), randomUUID()].sort();
    const matchId = randomUUID();
    await insertAccounts(pool, firstUserId, secondUserId);
    const matches = new MatchesRepository(databaseFor(pool) as never);
    const privacy = new PrivacyRepository(databaseFor(pool) as never);
    const match: MatchRow = {
      id: matchId,
      user1_id: firstUserId,
      user2_id: secondUserId,
      status: 'active',
      expires_at: new Date(Date.now() + 86_400_000),
      purge_after: null,
      continuation_initiator_id: null,
      created_at: new Date(),
      last_message_at: null,
    };

    try {
      await matches.create(match);
      await expect(privacy.blockUser(firstUserId, secondUserId)).resolves.toBe(true);
      const ended = await pool.query<{ status: string; purge_after: Date | null }>(
        'SELECT status, purge_after FROM match_init WHERE id = $1',
        [matchId],
      );
      expect(ended.rows[0]?.status).toBe('ended');
      expect(ended.rows[0]?.purge_after).toBeInstanceOf(Date);
      await expect(matches.create({ ...match, id: randomUUID(), created_at: new Date() })).rejects.toMatchObject({ reason: 'blocked' });
    } finally {
      await deleteAccounts(pool, firstUserId, secondUserId);
    }
  });

  it('completes an erasure request and removes or anonymizes all profile data', async () => {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const adminId = randomUUID();
    const [firstUserId, secondUserId] = [userId, otherUserId].sort();
    const matchId = randomUUID();
    await insertAccounts(pool, userId, otherUserId);
    await pool.query(`
      INSERT INTO user_account (user_id, role, phone_number_hash, phone_number_encrypted)
      VALUES ($1, 'admin', $2, $3)
    `, [adminId, `test-${adminId}`, Buffer.alloc(0)]);
    await pool.query(`INSERT INTO user_profile (user_id, firstname, birthdate, sex, bio, photo)
      VALUES ($1, 'Erase me', '1990-01-01', 'other', 'private bio', 'https://example.test/photo.jpg')`, [userId]);
    await pool.query(`INSERT INTO user_preferences (user_id, min_age, max_age, max_distance_km, looking_for)
      VALUES ($1, 18, 99, 50, 'both')`, [userId]);
    await pool.query(`INSERT INTO user_presence (user_id, latitude, longitude) VALUES ($1, 48.85, 2.35)`, [userId]);
    await pool.query(`INSERT INTO user_consent
      (user_id, consent_type, granted, document_version, ip_address, user_agent)
      VALUES ($1, 'sensitive_data_consent', true, 'test-v1', '127.0.0.1', 'integration-test')`, [userId]);
    await pool.query(`INSERT INTO user_block (blocker_id, blocked_id) VALUES ($1, $2)`, [userId, otherUserId]);
    await pool.query(`INSERT INTO match_init (id, user1_id, user2_id, status, expires_at)
      VALUES ($1, $2, $3, 'active', clock_timestamp() + INTERVAL '1 day')`, [matchId, firstUserId, secondUserId]);
    await pool.query(`INSERT INTO match_state (match_id, user_id) VALUES ($1, $2), ($1, $3)`, [matchId, userId, otherUserId]);
    await pool.query(`INSERT INTO chat_message (match_id, sender_id, content) VALUES ($1, $2, 'private message')`, [matchId, userId]);
    const privacy = new PrivacyRepository(databaseFor(pool) as never);

    try {
      const request = await privacy.createRequest(userId, 'erasure');
      expect(request).toBeDefined();
      await expect(privacy.updateRequest(request!.id, 'in_progress', adminId, 'admin', null, async () => undefined)).resolves.toBe('updated');
      await expect(privacy.updateRequest(request!.id, 'completed', adminId, 'admin', 'Identity verified.', async () => undefined)).resolves.toBe('updated');

      const [account, removed, consent, match, message, accessLog] = await Promise.all([
        pool.query<{ phone_number_hash: string; phone_number_encrypted: Buffer; deleted_at: Date | null; anonymized_at: Date | null }>(
          'SELECT phone_number_hash, phone_number_encrypted, deleted_at, anonymized_at FROM user_account WHERE user_id = $1', [userId],
        ),
        pool.query<{ profile: string | null; preferences: string | null; presence: string | null; blocks: number; state: number }>(`
          SELECT to_jsonb(profile)::text AS profile, to_jsonb(preferences)::text AS preferences,
            to_jsonb(presence)::text AS presence,
            (SELECT count(*)::integer FROM user_block WHERE blocker_id = $1 OR blocked_id = $1) AS blocks,
            (SELECT count(*)::integer FROM match_state WHERE user_id = $1) AS state
          FROM (SELECT 1) AS singleton
          LEFT JOIN user_profile profile ON profile.user_id = $1
          LEFT JOIN user_preferences preferences ON preferences.user_id = $1
          LEFT JOIN user_presence presence ON presence.user_id = $1
        `, [userId]),
        pool.query<{ withdrawn_at: Date | null; ip_address: string | null; user_agent: string | null }>(
          'SELECT withdrawn_at, ip_address::text, user_agent FROM user_consent WHERE user_id = $1', [userId],
        ),
        pool.query<{ status: string; purge_after: Date | null }>('SELECT status, purge_after FROM match_init WHERE id = $1', [matchId]),
        pool.query<{ content: string }>('SELECT content FROM chat_message WHERE match_id = $1 AND sender_id = $2', [matchId, userId]),
        pool.query<{ actions: string[] }>(`
          SELECT array_agg(action ORDER BY accessed_at) AS actions FROM data_access_log WHERE accessed_user_id = $1
        `, [userId]),
      ]);
      expect(account.rows[0]?.phone_number_hash).toMatch(/^anon_/);
      expect(account.rows[0]?.phone_number_encrypted).toHaveLength(0);
      expect(account.rows[0]?.deleted_at).toBeInstanceOf(Date);
      expect(account.rows[0]?.anonymized_at).toBeInstanceOf(Date);
      expect(removed.rows[0]).toEqual({ profile: null, preferences: null, presence: null, blocks: 0, state: 0 });
      expect(consent.rows[0]?.withdrawn_at).toBeInstanceOf(Date);
      expect(consent.rows[0]?.ip_address).toBeNull();
      expect(consent.rows[0]?.user_agent).toBeNull();
      expect(match.rows[0]?.status).toBe('ended');
      expect(match.rows[0]?.purge_after).toBeInstanceOf(Date);
      expect(message.rows[0]?.content).toBe('[Message supprimé]');
      expect(accessLog.rows[0]?.actions).toEqual(expect.arrayContaining(['admin_review_dsr', 'system_anonymize']));
    } finally {
      await deleteAccounts(pool, userId, otherUserId, adminId);
    }
  });

  it('replays a message idempotently and rejects key reuse for different content', async () => {
    const [firstUserId, secondUserId] = [randomUUID(), randomUUID()].sort();
    const matchId = randomUUID();
    const key = randomUUID();
    await insertAccounts(pool, firstUserId, secondUserId);
    const repository = new MatchesRepository(databaseFor(pool) as never);
    const match: MatchRow = {
      id: matchId,
      user1_id: firstUserId,
      user2_id: secondUserId,
      status: 'active',
      expires_at: new Date(Date.now() + 86_400_000),
      purge_after: null,
      continuation_initiator_id: null,
      created_at: new Date(),
      last_message_at: null,
    };

    try {
      await repository.create(match);
      const first = await repository.createMessage(randomUUID(), matchId, firstUserId, 'hello', key);
      const replay = await repository.createMessage(randomUUID(), matchId, firstUserId, 'hello', key);
      await expect(repository.createMessage(randomUUID(), matchId, firstUserId, 'different', key))
        .resolves.toEqual({ ok: false, reason: 'idempotency_conflict' });
      expect(first).toEqual(expect.objectContaining({ ok: true, value: expect.objectContaining({ created: true }) }));
      expect(replay).toEqual(expect.objectContaining({ ok: true, value: expect.objectContaining({ created: false }) }));
      if (first.ok && replay.ok) expect(replay.value.message.id).toBe(first.value.message.id);
      const count = await pool.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM chat_message WHERE match_id = $1', [matchId],
      );
      expect(count.rows[0]?.count).toBe(1);
    } finally {
      await deleteAccounts(pool, firstUserId, secondUserId);
    }
  });

  it('returns the mobile match summary without revealing a photo before mutual consent', async () => {
    const viewerId = randomUUID();
    const otherId = randomUUID();
    const [firstUserId, secondUserId] = [viewerId, otherId].sort();
    const matchId = randomUUID();
    await insertAccounts(pool, viewerId, otherId);
    await pool.query(`
      INSERT INTO user_profile (user_id, firstname, birthdate, sex, bio, photo) VALUES
        ($1, 'Viewer', '1990-01-01', 'male', 'viewer bio', 'https://example.test/viewer.jpg'),
        ($2, 'Other', '1992-01-01', 'female', 'other bio', 'https://example.test/other.jpg')
    `, [viewerId, otherId]);
    const repository = new MatchesRepository(databaseFor(pool) as never);
    const match: MatchRow = {
      id: matchId,
      user1_id: firstUserId,
      user2_id: secondUserId,
      status: 'active',
      expires_at: new Date(Date.now() + 86_400_000),
      purge_after: null,
      continuation_initiator_id: null,
      created_at: new Date(),
      last_message_at: null,
    };

    try {
      await repository.create(match);
      await repository.createMessage(randomUUID(), matchId, otherId, 'latest message', randomUUID());
      const hidden = await repository.listDetailedForUser(viewerId, 20, 0);
      expect(hidden[0]).toEqual(expect.objectContaining({
        other_user_id: otherId,
        other_firstname: 'Other',
        other_photo: null,
        my_revealed: false,
        photos_revealed: false,
        unread_count: 1,
        last_message_content: 'latest message',
      }));

      await pool.query('UPDATE match_state SET revealed = true WHERE match_id = $1', [matchId]);
      const revealed = await repository.listDetailedForUser(viewerId, 20, 0);
      expect(revealed[0]).toEqual(expect.objectContaining({
        other_photo: 'https://example.test/other.jpg',
        my_revealed: true,
        photos_revealed: true,
      }));
    } finally {
      await deleteAccounts(pool, viewerId, otherId);
    }
  });

  it('marks all received messages through a cursor message in one transaction', async () => {
    const [firstUserId, secondUserId] = [randomUUID(), randomUUID()].sort();
    const matchId = randomUUID();
    const newestId = randomUUID();
    await insertAccounts(pool, firstUserId, secondUserId);
    await pool.query(`
      INSERT INTO match_init (id, user1_id, user2_id, status, expires_at)
      VALUES ($1, $2, $3, 'active', clock_timestamp() + INTERVAL '1 day')
    `, [matchId, firstUserId, secondUserId]);
    await pool.query('INSERT INTO match_state (match_id, user_id) VALUES ($1, $2), ($1, $3)', [matchId, firstUserId, secondUserId]);
    await pool.query(`
      INSERT INTO chat_message (id, match_id, sender_id, content, created_at) VALUES
        ($1, $4, $5, 'incoming old', '2026-08-20T10:00:00Z'),
        ($2, $4, $6, 'outgoing', '2026-08-20T10:01:00Z'),
        ($3, $4, $5, 'incoming new', '2026-08-20T10:02:00Z')
    `, [randomUUID(), randomUUID(), newestId, matchId, secondUserId, firstUserId]);
    const repository = new MatchesRepository(databaseFor(pool) as never);

    try {
      const result = await repository.markMessagesReadThrough(matchId, newestId, firstUserId);
      expect(result).toEqual(expect.objectContaining({ ok: true, value: expect.objectContaining({ updated_count: 2 }) }));
      const messages = await pool.query<{ sender_id: string; read_at: Date | null }>(`
        SELECT sender_id, read_at FROM chat_message WHERE match_id = $1 ORDER BY created_at
      `, [matchId]);
      expect(messages.rows.filter((row) => row.sender_id === secondUserId).every((row) => row.read_at instanceof Date)).toBe(true);
      expect(messages.rows.find((row) => row.sender_id === firstUserId)?.read_at).toBeNull();
    } finally {
      await deleteAccounts(pool, firstUserId, secondUserId);
    }
  });

  it('consumes an account deletion confirmation token only once', async () => {
    const userId = randomUUID();
    const otherId = randomUUID();
    const tokenId = randomUUID();
    await insertAccounts(pool, userId, otherId);
    const repository = new UsersRepository(databaseFor(pool) as never);

    try {
      await expect(repository.replaceDeletionToken(
        userId, tokenId, 'token-hash', new Date(Date.now() + 600_000),
      )).resolves.toBe(true);
      await expect(repository.consumeDeletionToken(userId, tokenId, 'wrong-hash', new Date())).resolves.toBe(false);
      await expect(repository.consumeDeletionToken(userId, tokenId, 'token-hash', new Date())).resolves.toBe(true);
      await expect(repository.consumeDeletionToken(userId, tokenId, 'token-hash', new Date())).resolves.toBe(false);
    } finally {
      await deleteAccounts(pool, userId, otherId);
    }
  });

  it('removes Stripe customer/session identity and detaches retained invoices during anonymization', async () => {
    const userId = randomUUID();
    const otherId = randomUUID();
    const compactId = userId.replaceAll('-', '');
    const customerId = `cus_${compactId}`;
    const subscriptionId = `sub_${compactId}`;
    const invoiceId = `in_${compactId}`;
    await insertAccounts(pool, userId, otherId);

    try {
      await pool.query('INSERT INTO billing_customer (user_id, stripe_customer_id) VALUES ($1, $2)', [userId, customerId]);
      await pool.query(`
        INSERT INTO billing_checkout_session (
          id, user_id, idempotency_key, billing_period, stripe_session_id,
          checkout_url, status, expires_at
        ) VALUES ($1, $2, $3, 'monthly', $4, 'https://checkout.stripe.test/session', 'open', clock_timestamp() + INTERVAL '30 minutes')
      `, [randomUUID(), userId, randomUUID(), `cs_test_${compactId}`]);
      await pool.query(`
        INSERT INTO user_subscription (
          user_id, plan, provider, provider_subscription_id, provider_price_id,
          billing_period, status, current_period_ends_at, provider_event_created_at
        ) VALUES ($1, 'premium', 'stripe', $2, $3, 'monthly', 'active', clock_timestamp() + INTERVAL '1 month', clock_timestamp())
      `, [userId, subscriptionId, `price_${compactId}`]);
      await pool.query(`
        INSERT INTO billing_invoice (
          stripe_invoice_id, user_id, stripe_customer_id, stripe_subscription_id,
          status, currency, amount_due, amount_paid, amount_remaining,
          period_starts_at, period_ends_at, created_at
        ) VALUES ($1, $2, $3, $4, 'paid', 'EUR', 500, 500, 0,
          clock_timestamp(), clock_timestamp() + INTERVAL '1 month', clock_timestamp())
      `, [invoiceId, userId, customerId, subscriptionId]);

      await pool.query('SELECT fct_anonymize_user($1)', [userId]);

      const identity = await pool.query<{ customers: number; sessions: number; subscriptions: number }>(`
        SELECT
          (SELECT count(*)::integer FROM billing_customer WHERE user_id = $1) AS customers,
          (SELECT count(*)::integer FROM billing_checkout_session WHERE user_id = $1) AS sessions,
          (SELECT count(*)::integer FROM user_subscription WHERE user_id = $1) AS subscriptions
      `, [userId]);
      const invoice = await pool.query<{ user_id: string | null }>('SELECT user_id FROM billing_invoice WHERE stripe_invoice_id = $1', [invoiceId]);
      expect(identity.rows[0]).toEqual({ customers: 0, sessions: 0, subscriptions: 0 });
      expect(invoice.rows[0]?.user_id).toBeNull();
    } finally {
      await pool.query('DELETE FROM billing_invoice WHERE stripe_invoice_id = $1', [invoiceId]);
      await deleteAccounts(pool, userId, otherId);
    }
  });
});

type TestDatabase = {
  query: Pool['query'];
  transaction: <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;
};

function databaseFor(pool: Pool): TestDatabase {
  return {
    query: pool.query.bind(pool),
    transaction: async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

async function insertAccounts(database: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>, firstId: string, secondId: string): Promise<void> {
  await database.query(`
    INSERT INTO user_account (user_id, role, phone_number_hash, phone_number_encrypted)
    VALUES ($1, 'user', $2, $3), ($4, 'user', $5, $3)
  `, [firstId, `test-${firstId}`, Buffer.alloc(0), secondId, `test-${secondId}`]);
}

async function deleteAccounts(pool: Pool, ...userIds: string[]): Promise<void> {
  await pool.query(`
    DELETE FROM data_access_log
    WHERE accessed_user_id = ANY($1::uuid[]) OR accessor_id = ANY($1::uuid[])
  `, [userIds]);
  await pool.query('DELETE FROM user_account WHERE user_id = ANY($1::uuid[])', [userIds]);
}
