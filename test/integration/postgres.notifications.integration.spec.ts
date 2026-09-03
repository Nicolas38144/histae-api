import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DatabaseService } from '../../src/database/database.service';
import { enqueueNotification } from '../../src/mobile/notification-outbox';
import { NotificationPushRepository } from '../../src/mobile/notification-push.repository';
import { NotificationPushService } from '../../src/mobile/notification-push.service';
import { PushDeliveryError } from '../../src/mobile/push.service';
import { OutboxRepository } from '../../src/outbox/outbox.repository';
import { OutboxWorkerService } from '../../src/outbox/outbox-worker.service';
import { MatchesRepository } from '../../src/matches/matches.repository';
import { MatchMessageRepository } from '../../src/matches/match-message.repository';
import { BillingRepository } from '../../src/billing/billing.repository';
import { StripeWebhookService } from '../../src/billing/stripe-webhook.service';
import { loadMigration, migrations } from '../../scripts/migration-catalog';

dotenv.config();
if (process.env.ENV !== 'development' || process.env.POSTGRES_DB !== 'histae-dev'
  || !['localhost', '127.0.0.1', '::1'].includes(process.env.POSTGRES_HOST ?? '')) {
  throw new Error('Notification integration tests require local development PostgreSQL histae-dev.');
}
const postgres = {
  host: process.env.POSTGRES_HOST, port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER, password: process.env.POSTGRES_PASSWORD, database: process.env.POSTGRES_DB,
  ssl: process.env.POSTGRES_SSLMODE !== 'disable',
};

describe('PostgreSQL durable notifications', () => {
  // Workers must never claim real development jobs: every table lives in a disposable schema.
  const schema = `notification_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool(postgres);
  const isolated = { ...postgres, options: `-c search_path=${schema},public` };
  const pool = new Pool(isolated);
  const database = new DatabaseService({ postgres: isolated } as never);
  const outbox = new OutboxRepository(database);
  const deliveries = new NotificationPushRepository(database);
  const matches = new MatchesRepository(database);
  const messages = new MatchMessageRepository(database);
  let createdSchema = false;
  let owner: string;
  let other: string;
  let deviceId: string;
  let sessionId: string;
  let invoiceId: string;

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    createdSchema = true;
    for (const migration of migrations) {
      await database.transaction(async (client) => { await client.query((await loadMigration(migration)).sql); });
    }
    await database.onModuleInit();
  }, 60_000);

  beforeEach(async () => {
    owner = await account();
    other = await account();
    ({ deviceId, sessionId } = await device(owner));
    invoiceId = `in_${owner.replaceAll('-', '')}`;
    await database.transaction((client) => new BillingRepository(database).upsertInvoice(owner, {
      stripeInvoiceId: invoiceId, stripeCustomerId: 'cus_Review', stripeSubscriptionId: 'sub_Review',
      status: 'open', currency: 'EUR', amountDue: 500, amountPaid: 0, amountRemaining: 500,
      periodStartsAt: new Date(), periodEndsAt: new Date(Date.now() + 86_400_000),
      paidAt: null, createdAt: new Date(), eventCreatedAt: new Date(),
    }, client));
  });

  afterEach(async () => {
    expect((await pool.query('SELECT current_schema() AS name')).rows[0].name).toBe(schema);
    await pool.query('DELETE FROM match_init');
    await pool.query('DELETE FROM outbox_event');
    await pool.query('DELETE FROM stripe_webhook_event');
    await pool.query('DELETE FROM billing_invoice');
    await pool.query('DELETE FROM user_account');
  });

  afterAll(async () => {
    await database.onModuleDestroy();
    await pool.end();
    if (createdSchema && /^notification_test_[a-f0-9]{32}$/.test(schema)) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    }
    await admin.end();
  });

  async function account(): Promise<string> {
    const id = randomUUID();
    await pool.query(`INSERT INTO user_account (user_id, role, phone_number_hash, phone_number_encrypted)
      VALUES ($1, 'user', $2, $3)`, [id, `test-${id}`, Buffer.alloc(0)]);
    return id;
  }

  async function device(userId: string) {
    const id = randomUUID();
    const session = randomUUID();
    await pool.query(`INSERT INTO refresh_token_family (id, user_id, created_at, last_refreshed_at, expires_at)
      VALUES ($1, $2, now(), now(), now() + interval '1 day')`, [session, userId]);
    await pool.query(`INSERT INTO device_token (id, user_id, session_id, token, platform)
      VALUES ($1, $2, $3, $4, 'ios')`, [id, userId, session, `test-token-${id}`]);
    return { deviceId: id, sessionId: session };
  }

  async function schedule(source = randomUUID()) {
    await database.transaction((client) => enqueueNotification(client, owner, source, { type: 'billing_payment_failed', invoiceId }));
    await pool.query("UPDATE outbox_event SET available_at = now() - interval '1 second' WHERE status = 'pending'");
    return (await pool.query('SELECT id FROM outbox_event ORDER BY created_at, id')).rows[0].id as string;
  }

  async function createMatch() {
    const [first, second] = [owner, other].sort() as [string, string];
    const match = {
      id: randomUUID(), user1_id: first, user2_id: second, status: 'active' as const,
      expires_at: new Date(Date.now() + 86_400_000), created_at: new Date(), purge_after: null,
      continuation_initiator_id: null, last_message_at: null,
    };
    await matches.create(match);
    return match;
  }

  async function expectBlocked(blockedId: number, blockerId: number) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await pool.query('SELECT $1 = ANY(pg_blocking_pids($2)) AS blocked', [blockerId, blockedId])).rows[0].blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Expected PostgreSQL lock barrier was not reached');
  }

  function billingEvents() {
    const now = Math.floor(Date.now() / 1_000);
    const subscription = {
      id: 'sub_Review', customer: 'cus_Review', status: 'trialing', cancel_at_period_end: false,
      metadata: { histae_user_id: owner }, trial_start: now - 86_400, trial_end: now + 86_400, canceled_at: null,
      items: { data: [{ price: { id: 'price_ReviewMonthly', product: 'prod_Review' },
        current_period_start: now - 86_400, current_period_end: now + 172_800 }] },
    };
    let event: object;
    const stripe = { constructWebhookEvent: () => event, retrieveSubscription: async () => subscription };
    const config = { billing: { provider: 'stripe', stripeSecretKey: 'sk_test_review', premiumProductId: 'prod_Review',
      premiumMonthlyPriceId: 'price_ReviewMonthly', premiumAnnualPriceId: 'price_ReviewAnnual' } };
    const service = new StripeWebhookService(new BillingRepository(database), stripe as never, config as never,
      { subscriptionUpdated: jest.fn() } as never);
    return { now, subscription, handle: async (type: string, object: object, created = now) => {
      event = { id: `evt_${randomUUID().replaceAll('-', '')}`, type, created,
        livemode: false, api_version: null, data: { object } };
      await service.handle(Buffer.from('{}'), 'simulated');
    } };
  }

  it('R01 review: erasure must exclude a concurrently created match notification', async () => {
    await pool.query('DELETE FROM device_token WHERE user_id = $1', [owner]);
    await pool.query(`INSERT INTO user_consent (user_id, consent_type, granted, document_version)
      VALUES ($1, 'privacy_notice_acknowledgement', true, 'review')`, [owner]);
    const barrier = await pool.connect();
    const erasing = await pool.connect();
    let erasure: Promise<unknown> | undefined;
    try {
      await barrier.query('BEGIN');
      const barrierId = (await barrier.query('SELECT pg_backend_pid() AS id')).rows[0].id;
      const erasingId = (await erasing.query('SELECT pg_backend_pid() AS id')).rows[0].id;
      await barrier.query('SELECT id FROM user_consent WHERE user_id = $1 FOR UPDATE', [owner]);
      await erasing.query("SET statement_timeout = '10s'");
      erasure = erasing.query('SELECT fct_anonymize_user($1)', [owner]).catch((error: unknown) => error);
      await expectBlocked(erasingId, barrierId);
      await createMatch();
      await barrier.query('ROLLBACK');
      const result = await erasure;
      if (result instanceof Error) throw result;
      expect((await pool.query('SELECT deleted_at FROM user_account WHERE user_id = $1', [owner])).rows[0].deleted_at).not.toBeNull();
      expect((await pool.query('SELECT id FROM notification WHERE user_id = $1', [owner])).rows).toHaveLength(0);
    } finally {
      await barrier.query('ROLLBACK');
      await erasure;
      barrier.release();
      erasing.release();
    }
  }, 15_000);

  it('R01 review: an obsolete trial event must not send after activation', async () => {
    const { now, subscription, handle } = billingEvents();
    await handle('customer.subscription.updated', { ...subscription, status: 'active' });
    await handle('customer.subscription.trial_will_end', subscription, now - 3_600);
    expect((await pool.query('SELECT status FROM user_subscription WHERE user_id = $1', [owner])).rows[0].status).toBe('active');
    expect((await pool.query('SELECT id FROM notification')).rows).toHaveLength(0);
    await pool.query("UPDATE outbox_event SET available_at = now() - interval '1 second'");
    const send = jest.fn().mockResolvedValue(undefined);
    await worker(send).runOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['writer_first', 'erasure_first'] as const)('serializes notification and erasure with %s', async (order) => {
    const first = await pool.connect();
    const second = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await first.query('BEGIN');
      await second.query("SET statement_timeout = '10s'");
      const firstId = (await first.query('SELECT pg_backend_pid() AS id')).rows[0].id;
      const secondId = (await second.query('SELECT pg_backend_pid() AS id')).rows[0].id;
      const enqueue = (client: typeof first) => enqueueNotification(client, owner, randomUUID(), { type: 'billing_payment_failed', invoiceId });
      if (order === 'writer_first') {
        await enqueue(first);
        pending = second.query('SELECT fct_anonymize_user($1)', [owner]).catch((error: unknown) => error);
      } else {
        await first.query('SELECT fct_anonymize_user($1)', [owner]);
        pending = enqueue(second).catch((error: unknown) => error);
      }
      await expectBlocked(secondId, firstId);
      await first.query('COMMIT');
      const result = await pending;
      if (result instanceof Error) throw result;
      expect((await pool.query('SELECT id FROM notification WHERE user_id = $1', [owner])).rows).toHaveLength(0);
      expect((await pool.query('SELECT id FROM notification_push_delivery')).rows).toHaveLength(0);
    } finally {
      await first.query('ROLLBACK');
      await pending;
      first.release();
      second.release();
    }
  }, 15_000);

  it.each(['active', 'extended', 'expired'] as const)('does not send a queued trial alert after it becomes %s', async (state) => {
    const { subscription, handle } = billingEvents();
    await handle('customer.subscription.trial_will_end', subscription);
    const job = (await pool.query('SELECT id FROM outbox_event')).rows[0].id as string;
    expect(await deliveries.findDeliverable(job)).toBeDefined();
    if (state === 'active') await pool.query("UPDATE user_subscription SET status = 'active' WHERE user_id = $1", [owner]);
    if (state === 'extended') await pool.query("UPDATE user_subscription SET trial_ends_at = trial_ends_at + interval '1 day' WHERE user_id = $1", [owner]);
    if (state === 'expired') {
      await pool.query("UPDATE user_subscription SET trial_ends_at = now() - interval '1 hour' WHERE user_id = $1", [owner]);
      await pool.query('UPDATE notification SET billing_trial_ends_at = (SELECT trial_ends_at FROM user_subscription WHERE user_id = $1)', [owner]);
    }
    await pool.query("UPDATE outbox_event SET available_at = now() - interval '1 second'");
    const send = jest.fn().mockResolvedValue(undefined);
    expect((await worker(send).runOnce()).completed).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends a still relevant trial alert without exposing its internal context', async () => {
    const { subscription, handle } = billingEvents();
    await handle('customer.subscription.trial_will_end', subscription);
    await pool.query("UPDATE outbox_event SET available_at = now() - interval '1 second'");
    const send = jest.fn().mockResolvedValue(undefined);
    expect((await worker(send).runOnce()).completed).toBe(1);
    expect(send).toHaveBeenCalledWith(`test-token-${deviceId}`, 'subscription_trial_ending', { notification_id: expect.any(String) });
    expect((await pool.query('SELECT payload FROM notification')).rows).toEqual([{ payload: {} }]);
  });

  it('ignores an old failure webhook after the invoice was paid', async () => {
    const { subscription, now, handle } = billingEvents();
    const invoice = { id: invoiceId, customer: subscription.customer, status: 'paid', currency: 'eur',
      parent: { subscription_details: { subscription: subscription.id } },
      amount_due: 500, amount_paid: 500, amount_remaining: 0,
      period_start: now, period_end: now + 86_400, created: now,
      status_transitions: { paid_at: now } };
    await handle('invoice.paid', invoice, now + 1);
    await handle('invoice.payment_failed', { ...invoice, status: 'open', amount_paid: 0, amount_remaining: 500,
      status_transitions: { paid_at: null } }, now - 1);
    expect((await pool.query('SELECT status FROM billing_invoice WHERE stripe_invoice_id = $1', [invoiceId])).rows[0].status).toBe('paid');
    expect((await pool.query('SELECT id FROM notification')).rows).toHaveLength(0);
  });

  it.each(['paid', 'void', 'uncollectible', 'settled', 'other_owner', 'legacy'] as const)(
    'does not send a queued payment alert when the invoice context becomes %s', async (state) => {
      await schedule();
      if (['paid', 'void', 'uncollectible'].includes(state)) {
        await pool.query('UPDATE billing_invoice SET status = $2 WHERE stripe_invoice_id = $1', [invoiceId, state]);
      }
      if (state === 'settled') await pool.query('UPDATE billing_invoice SET amount_remaining = 0 WHERE stripe_invoice_id = $1', [invoiceId]);
      if (state === 'other_owner') await pool.query('UPDATE billing_invoice SET user_id = $2 WHERE stripe_invoice_id = $1', [invoiceId, other]);
      if (state === 'legacy') await pool.query('UPDATE notification SET billing_reference = NULL');
      const send = jest.fn().mockResolvedValue(undefined);
      expect((await worker(send).runOnce()).completed).toBe(1);
      expect(send).not.toHaveBeenCalled();
    });

  function worker(send = jest.fn().mockResolvedValue(undefined), repository = outbox) {
    const notifications = new NotificationPushService(deliveries, { sendToDevice: send } as never);
    return new OutboxWorkerService(repository, {} as never, {} as never,
      { maintenanceMode: 'disabled' } as never, {} as never, notifications);
  }

  it('rolls back intent and jobs together and exposes neither before commit', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await enqueueNotification(client, owner, randomUUID(), { type: 'billing_payment_failed', invoiceId });
      expect((await pool.query('SELECT id FROM notification')).rows).toHaveLength(0);
      expect((await pool.query('SELECT id FROM outbox_event')).rows).toHaveLength(0);
      expect((await client.query('SELECT id FROM notification_push_delivery')).rows).toHaveLength(1);
      await client.query('ROLLBACK');
      expect((await pool.query('SELECT id FROM notification')).rows).toHaveLength(0);
    } finally { await client.query('ROLLBACK'); client.release(); }
    await schedule();
    expect((await pool.query('SELECT id FROM notification')).rows).toHaveLength(1);
    expect((await pool.query('SELECT payload FROM outbox_event')).rows).toEqual([{ payload: {} }]);
  });

  it('deduplicates concurrent source replay and creates independent per-device jobs', async () => {
    await device(owner);
    const source = randomUUID();
    await Promise.all([schedule(source), schedule(source)]);
    expect((await pool.query('SELECT id FROM notification')).rows).toHaveLength(1);
    expect((await pool.query('SELECT id FROM outbox_event')).rows).toHaveLength(2);
  });

  it('persists match notifications in the creation transaction and never duplicates a replay', async () => {
    await device(other);
    const match = await createMatch();
    await expect(matches.create(match)).rejects.toHaveProperty('code', '23505');
    expect((await pool.query("SELECT user_id FROM notification WHERE type = 'new_match'")).rows).toHaveLength(2);
    expect((await pool.query('SELECT id FROM outbox_event')).rows).toHaveLength(2);
  });

  it('persists a single content-free notification for an idempotent message', async () => {
    const match = await createMatch();
    const key = randomUUID();
    const id = randomUUID();
    await messages.createMessage(id, match.id, other, 'private chat text', key);
    await messages.createMessage(randomUUID(), match.id, other, 'private chat text', key);
    const notifications = (await pool.query("SELECT user_id, payload FROM notification WHERE type = 'new_message'")).rows;
    expect(notifications).toEqual([{ user_id: owner, payload: { match_id: match.id, message_id: id, sender_id: other } }]);
    expect(JSON.stringify((await pool.query('SELECT * FROM notification')).rows)).not.toContain('private chat text');
  });

  it('rolls back a message if its notification cannot be persisted', async () => {
    const match = await createMatch();
    const failingDatabase = { transaction: (work: Parameters<DatabaseService['transaction']>[0]) => database.transaction((client) => {
      const query = client.query.bind(client);
      return work(new Proxy(client, { get(target, key) {
        if (key !== 'query') return Reflect.get(target, key);
        return (sql: string, values?: unknown[]) => {
          if (sql.includes('INSERT INTO notification')) throw new Error('injected notification failure');
          return query(sql, values);
        };
      } }));
    }) };
    await expect(new MatchMessageRepository(failingDatabase as never)
      .createMessage(randomUUID(), match.id, other, 'rollback text', randomUUID())).rejects.toThrow('injected notification failure');
    expect((await pool.query('SELECT id FROM chat_message')).rows).toHaveLength(0);
    expect((await pool.query("SELECT id FROM notification WHERE type = 'new_message'")).rows).toHaveLength(0);
  });

  it('commits a Stripe deduplication marker and its intent atomically', async () => {
    const billing = new BillingRepository(database);
    const metadata = { id: `evt_${randomUUID().replaceAll('-', '')}`, type: 'invoice.payment_failed', objectId: 'in_test', livemode: false,
      apiVersion: null, createdAt: new Date() };
    await expect(billing.processWebhook(metadata, async (client) => {
      await enqueueNotification(client, owner, metadata.id, { type: 'billing_payment_failed', invoiceId });
      throw new Error('injected rollback');
    })).rejects.toThrow('injected rollback');
    expect(await billing.webhookProcessed(metadata.id)).toBe(false);
    expect((await pool.query('SELECT id FROM outbox_event')).rows).toHaveLength(0);
    const persist = () => billing.processWebhook(metadata, (client) =>
      enqueueNotification(client, owner, metadata.id, { type: 'billing_payment_failed', invoiceId }));
    await persist();
    expect((await persist()).duplicate).toBe(true);
    expect((await pool.query('SELECT id FROM notification')).rows).toHaveLength(1);
    await pool.query("UPDATE outbox_event SET available_at = now() - interval '1 second' WHERE status = 'pending'");
    expect((await worker().runOnce()).completed).toBe(1);
  });

  it('recovers a crashed claim and fences its former owner', async () => {
    const id = await schedule();
    const abandoned = randomUUID();
    await outbox.claimBatch(abandoned, new Date(), new Date(0), 50);
    await pool.query("UPDATE outbox_event SET locked_at = now() - interval '6 minutes' WHERE id = $1", [id]);
    const send = jest.fn().mockResolvedValue(undefined);
    expect((await worker(send).runOnce()).completed).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await outbox.renewClaim(id, abandoned)).toBe(false);
    expect(await outbox.complete(id, abandoned, new Date())).toBe(false);
  });

  it('lets concurrent workers deliver each device once under normal acknowledgements', async () => {
    await device(owner);
    await schedule();
    const send = jest.fn().mockResolvedValue(undefined);
    const results = await Promise.all([worker(send).runOnce(), worker(send).runOnce()]);
    expect(results.reduce((sum, result) => sum + result.completed, 0)).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(new Set(send.mock.calls.map((call) => call[0])).size).toBe(2);
  });

  it('retries only the failed device, without duplicating the persisted notification', async () => {
    const second = await device(owner);
    await schedule();
    const failedToken = `test-token-${second.deviceId}`;
    const send = jest.fn(async (token: string) => { if (token === failedToken) throw new PushDeliveryError(); });
    const first = await worker(send).runOnce();
    expect(first).toMatchObject({ completed: 1, retried: 1 });
    await pool.query("UPDATE outbox_event SET available_at = now() - interval '1 second' WHERE status = 'pending'");
    send.mockResolvedValue(undefined);
    expect((await worker(send).runOnce()).completed).toBe(1);
    expect(send.mock.calls.filter((call) => call[0] !== failedToken)).toHaveLength(1);
    expect((await pool.query('SELECT id FROM notification')).rows).toHaveLength(1);
  });

  it('reuses notification_id after an uncertain send/ack boundary', async () => {
    await schedule();
    const send = jest.fn().mockResolvedValue(undefined);
    const completion = jest.spyOn(outbox, 'complete').mockRejectedValueOnce(new Error('ack lost'));
    expect((await worker(send).runOnce()).retried).toBe(1);
    completion.mockRestore();
    await pool.query("UPDATE outbox_event SET available_at = now() - interval '1 second' WHERE status = 'pending'");
    expect((await worker(send).runOnce()).completed).toBe(1);
    expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
    expect((await pool.query('SELECT id FROM notification')).rows).toHaveLength(1);
  });

  it.each(['banned', 'erased', 'expired', 'revoked', 'reassigned', 'same_user_new_session'] as const)(
    'does not send after the target becomes %s', async (state) => {
    const id = await schedule();
    if (state === 'banned') await pool.query('UPDATE user_account SET is_banned = true WHERE user_id = $1', [owner]);
    if (state === 'erased') await pool.query('SELECT fct_anonymize_user($1)', [owner]);
    if (state === 'expired') await pool.query("UPDATE notification SET expires_at = now() - interval '1 second'");
    if (state === 'revoked') await pool.query("UPDATE refresh_token_family SET revoked_at = now(), revocation_reason = 'logout' WHERE id = $1", [sessionId]);
    if (state === 'reassigned' || state === 'same_user_new_session') {
      const replacement = await device(state === 'reassigned' ? other : owner);
      await pool.query('UPDATE device_token SET user_id = $2, session_id = $3 WHERE id = $1', [deviceId, state === 'reassigned' ? other : owner, replacement.sessionId]);
    }
    expect(await deliveries.findDeliverable(id)).toBeUndefined();
    const send = jest.fn();
    expect((await worker(send).runOnce()).completed).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('suppresses message delivery after reading or blocking the match', async () => {
    const match = await createMatch();
    const messageId = randomUUID();
    await messages.createMessage(messageId, match.id, other, 'read me', randomUUID());
    const job = (await pool.query(`SELECT delivery.id FROM notification_push_delivery delivery
      JOIN notification n ON n.id = delivery.notification_id WHERE n.type = 'new_message'`)).rows[0].id as string;
    expect(await deliveries.findDeliverable(job)).toBeDefined();
    await messages.markMessageRead(match.id, messageId, owner);
    expect(await deliveries.findDeliverable(job)).toBeUndefined();
    await pool.query('INSERT INTO user_block (blocker_id, blocked_id) VALUES ($1, $2)', [owner, other]);
    for (const row of (await pool.query('SELECT id FROM notification_push_delivery')).rows) {
      expect(await deliveries.findDeliverable(row.id as string)).toBeUndefined();
    }
  });

  it('supports audited retry/discard of push dead letters without removing inbox entries', async () => {
    const id = await schedule();
    await pool.query("UPDATE outbox_event SET attempts = 9, available_at = now() - interval '1 second' WHERE id = $1", [id]);
    const send = jest.fn().mockRejectedValue(new PushDeliveryError());
    expect((await worker(send).runOnce()).deadLettered).toBe(1);
    const snapshot = await outbox.statusSnapshot();
    expect(snapshot.dead_letter).toBe(1);
    expect(snapshot.notification_push).toMatchObject({ dead_letter: 1, pending: 0, completed: 0 });
    const listed = await outbox.listDeadLetters(10);
    expect(listed[0]).toMatchObject({ event_type: 'notification.push', last_error_code: 'push_delivery_unavailable' });
    expect(listed[0]).not.toHaveProperty('payload');
    const operator = { userId: other, role: 'admin' as const };
    expect(await outbox.retryDeadLetter(id, operator, 'Provider recovered')).toBe('updated');
    await pool.query("UPDATE outbox_event SET attempts = 9, available_at = now() - interval '1 second' WHERE id = $1", [id]);
    await worker(send).runOnce();
    expect(await outbox.discardDeadLetter(id, operator, 'Notification no longer useful')).toBe('updated');
    expect((await pool.query('SELECT id FROM notification')).rows).toHaveLength(1);
    expect((await pool.query('SELECT id FROM outbox_operator_action')).rows).toHaveLength(2);
  });

  it('purges delivery references with resolved events, and cascades them on notification expiration', async () => {
    const id = await schedule();
    await worker().runOnce();
    await pool.query("UPDATE outbox_event SET processed_at = now() - interval '8 days' WHERE id = $1", [id]);
    expect(await outbox.purgeCompleted(new Date(Date.now() - 7 * 86_400_000), 50)).toBe(1);
    expect((await pool.query('SELECT id FROM notification_push_delivery')).rows).toHaveLength(0);
    await schedule();
    await pool.query('DELETE FROM notification');
    expect((await pool.query('SELECT id FROM notification_push_delivery')).rows).toHaveLength(0);
  });
});
