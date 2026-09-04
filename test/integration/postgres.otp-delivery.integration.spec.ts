import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OtpRepository } from '../../src/auth/otp.repository';
import { OtpService } from '../../src/auth/otp.service';
import { SmsDeliveryError, type OtpSms } from '../../src/auth/sms-delivery';
import { SweegoWebhookService } from '../../src/auth/sweego-webhook.service';
import { SweegoWebhookMetricsService } from '../../src/auth/sweego-webhook-metrics.service';
import { SweegoSmsService } from '../../src/auth/sweego-sms.service';
import { hmacSha256 } from '../../src/crypto/phone-crypto';
import { IsolatedPostgres, eventually } from '../helpers/isolated-postgres';
import { signSmsBody, smsEvent, sweegoSecret } from '../helpers/sweego-fixtures';

describe('OTP delivery recovery on real PostgreSQL', () => {
  const fixture = new IsolatedPostgres();
  const repository = new OtpRepository(fixture.database);
  const config = { phone: { hashKey: 'h'.repeat(32) }, sms: { provider: 'sweego', region: 'FR', senderId: 'Histae',
    timeoutMillis: 10_000, otpTtlMillis: 600_000, webhookSecret: sweegoSecret } };
  const phone = '+33600000000';
  const phoneHash = hmacSha256(phone, config.phone.hashKey);
  const webhooks = new SweegoWebhookService(config as never, repository, new SweegoWebhookMetricsService());
  beforeAll(() => fixture.start(), 60_000);
  beforeEach(() => fixture.reset());
  afterAll(() => fixture.stop());

  async function begin(otpHash = randomUUID(), overrides = {}) {
    const input = { id: randomUUID(), phoneHash, otpHash, idempotencyKey: randomUUID(), ttlMillis: 600_000,
      settlementMillis: 15_000, ...overrides };
    expect(await repository.beginOtpDelivery(input)).toEqual({ state: 'created', id: input.id });
    return input;
  }
  const event = (id: string, type: 'sms_sent' | 'sms_undelivered' = 'sms_sent') =>
    ({ deliveryId: id, messageId: `msg-${id}`, type });
  const accept = (id: string) => repository.markOtpAccepted(id, phoneHash, `tx-${id}`, `msg-${id}`);
  async function row(id: string) {
    return (await fixture.pool.query('SELECT * FROM otp_verification WHERE id = $1', [id])).rows[0];
  }
  async function callback(message: OtpSms, type = 'sms_sent') {
    const body = Buffer.from(JSON.stringify(smsEvent({ campaign_id: message.deliveryId,
      swg_uid: `msg-${message.deliveryId}`, event_type: type })));
    await webhooks.handle(body, signSmsBody(body));
  }

  it('creates one attempt under concurrent identical retries, and rejects a key bound to another phone', async () => {
    const input = { id: randomUUID(), phoneHash, otpHash: 'hash', idempotencyKey: randomUUID(), ttlMillis: 600_000, settlementMillis: 15_000 };
    const results = await Promise.all([repository.beginOtpDelivery(input), repository.beginOtpDelivery({ ...input, id: randomUUID() })]);
    expect(results.map(result => result.state).sort()).toEqual(['created', 'pending']);
    expect((await fixture.pool.query('SELECT id FROM otp_verification')).rowCount).toBe(1);
    expect(await repository.beginOtpDelivery({ ...input, id: randomUUID(), phoneHash: 'another-phone' })).toEqual({ state: 'conflict' });
  });

  it('does not activate an unconfirmed attempt and distinguishes acceptance from provider sms_sent', async () => {
    const attempt = await begin();
    expect(await repository.consumeOtp(phoneHash, attempt.otpHash)).toBe(false);
    await accept(attempt.id);
    expect(await row(attempt.id)).toMatchObject({ delivery_status: 'accepted', provider_sent_at: null });
    await repository.applySmsEvent(event(attempt.id));
    expect(await row(attempt.id)).toMatchObject({ delivery_status: 'sent', provider_sent_at: expect.any(Date) });
  });

  it('recovers a received SMS after a lost response through the signed callback, consuming it exactly once', async () => {
    let sent!: OtpSms;
    const sms = { sendOtp: jest.fn(async (message: OtpSms) => { sent = message;
      throw new SmsDeliveryError('provider_network_error', 'unknown'); }) };
    const service = new OtpService(config as never, repository, sms);
    const key = randomUUID();
    await expect(service.send(phone, key)).rejects.toMatchObject({ code: 'otp_delivery_unknown' });
    expect(await row(sent.deliveryId)).toMatchObject({ delivery_status: 'unknown' });
    await expect(service.consume(phone, sent.code)).rejects.toMatchObject({ code: 'invalid_or_expired_otp' });
    await callback(sent);
    await expect(service.send(phone, key)).resolves.toHaveProperty('message');
    const consumed = await Promise.allSettled(Array.from({ length: 8 }, () => service.consume(phone, sent.code)));
    expect(consumed.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(sms.sendOtp).toHaveBeenCalledTimes(1);
    await callback(sent);
    await expect(service.consume(phone, sent.code)).rejects.toMatchObject({ code: 'invalid_or_expired_otp' });
  });

  it('accepts a callback arriving before /send times out without overwriting the confirmed state', async () => {
    const sms = { sendOtp: jest.fn(async (message: OtpSms) => {
      await callback(message);
      throw new SmsDeliveryError('provider_network_error', 'unknown');
    }) };
    await expect(new OtpService(config as never, repository, sms).send(phone, randomUUID())).resolves.toHaveProperty('message');
    expect((await repository.statusSnapshot()).states).toMatchObject({ sent: 1, unknown: 0 });
  });

  it('does not downgrade a callback when the HTTP receipt arrives later', async () => {
    const attempt = await begin();
    await repository.applySmsEvent(event(attempt.id));
    await accept(attempt.id);
    expect(await row(attempt.id)).toMatchObject({ delivery_status: 'sent', provider_transaction_id: `tx-${attempt.id}` });
  });

  it.each([true, false])('makes undelivered absorbing whatever the callback order (sent first: %s)', async sentFirst => {
    const attempt = await begin();
    const events = [event(attempt.id), event(attempt.id, 'sms_undelivered')];
    if (!sentFirst) events.reverse();
    for (const item of events) await repository.applySmsEvent(item);
    expect(await accept(attempt.id)).toBe(false);
    expect(await repository.consumeOtp(phoneHash, attempt.otpHash)).toBe(false);
    expect(await row(attempt.id)).toMatchObject({ delivery_status: 'failed', delivery_error_code: 'provider_undelivered' });
  });

  it('keeps an older accepted code valid after a newer definitive HTTP rejection', async () => {
    const first = await begin(), failed = await begin();
    await accept(first.id);
    await repository.markOtpOutcome(failed.id, phoneHash, 'failed', 'provider_rejected');
    expect(await repository.consumeOtp(phoneHash, failed.otpHash)).toBe(false);
    expect(await repository.consumeOtp(phoneHash, first.otpHash)).toBe(true);
  });

  it('settles abandoned pending attempts as unknown, including the read-only operational view', async () => {
    const attempt = await begin();
    await fixture.pool.query("UPDATE otp_verification SET settlement_deadline = clock_timestamp() - INTERVAL '1 second' WHERE id = $1", [attempt.id]);
    expect((await repository.statusSnapshot()).states).toMatchObject({ pending: 0, unknown: 1 });
    expect(await repository.beginOtpDelivery({ ...attempt, id: randomUUID() })).toMatchObject({ state: 'unknown' });
    expect(await row(attempt.id)).toMatchObject({ delivery_status: 'unknown', delivery_error_code: 'delivery_unknown' });
    await repository.applySmsEvent(event(attempt.id));
    expect(await repository.consumeOtp(phoneHash, attempt.otpHash)).toBe(true);
  });

  it.each(['callback', 'receipt'] as const)('never revives a superseded ancestor through a late %s', async source => {
    const old = await begin(), current = await begin();
    await accept(current.id);
    expect(await repository.consumeOtp(phoneHash, current.otpHash)).toBe(true);
    if (source === 'callback') await repository.applySmsEvent(event(old.id));
    else await accept(old.id);
    expect(await row(old.id)).toMatchObject({ used: true });
    expect(await repository.consumeOtp(phoneHash, old.otpHash)).toBe(false);
    expect(await repository.consumeOtp(phoneHash, current.otpHash)).toBe(false);
  });

  it('allows only the newest accepted attempt when acceptances and callbacks race', async () => {
    const first = await begin(), second = await begin();
    await Promise.all([accept(second.id), repository.applySmsEvent(event(first.id)), accept(first.id), repository.applySmsEvent(event(second.id))]);
    expect(await repository.consumeOtp(phoneHash, first.otpHash)).toBe(false);
    expect(await repository.consumeOtp(phoneHash, second.otpHash)).toBe(true);
    expect(await repository.consumeOtp(phoneHash, second.otpHash)).toBe(false);
  });

  it('deduplicates callback effects without extending the OTP expiry or recording raw events', async () => {
    const attempt = await begin();
    expect(await repository.applySmsEvent(event(attempt.id))).toBe('applied');
    const before = await row(attempt.id);
    expect(await repository.applySmsEvent(event(attempt.id))).toBe('ignored');
    expect(await row(attempt.id)).toEqual(before);
    expect((await repository.statusSnapshot()).states.sent).toBe(1);
  });

  it('rejects mismatched message/transaction correlation without changing delivery or usability', async () => {
    const attempt = await begin();
    await accept(attempt.id);
    const before = await row(attempt.id);
    expect(await repository.applySmsEvent({ ...event(attempt.id), messageId: 'wrong-message' })).toBe('conflict');
    expect(await repository.applySmsEvent({ ...event(attempt.id), transactionId: 'wrong-transaction' })).toBe('conflict');
    expect(await repository.markOtpAccepted(attempt.id, phoneHash, 'wrong-transaction', `msg-${attempt.id}`)).toBe(false);
    expect(await row(attempt.id)).toEqual(before);
  });

  it('does not revive an expired or already purged OTP', async () => {
    const attempt = await begin();
    await fixture.pool.query("UPDATE otp_verification SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1", [attempt.id]);
    await repository.applySmsEvent(event(attempt.id));
    expect(await repository.consumeOtp(phoneHash, attempt.otpHash)).toBe(false);
    expect((await repository.statusSnapshot()).states.sent).toBe(0);
    await fixture.pool.query('DELETE FROM otp_verification WHERE id = $1', [attempt.id]);
    expect(await repository.applySmsEvent(event(attempt.id))).toBe('ignored');
    expect(await row(attempt.id)).toBeUndefined();
  });

  it('checks expiry after waiting for the phone lock', async () => {
    const attempt = await begin();
    await accept(attempt.id);
    const blocker = await fixture.pool.connect();
    let consumed: Promise<boolean> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [phoneHash]);
      consumed = repository.consumeOtp(phoneHash, attempt.otpHash);
      await eventually(async () => (await fixture.pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE application_name = $1 AND wait_event = 'advisory'`, [fixture.schema])).rowCount! > 0);
      await blocker.query("UPDATE otp_verification SET expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1", [attempt.id]);
      await blocker.query('COMMIT');
      expect(await consumed).toBe(false);
    } finally {
      await blocker.query('ROLLBACK'); blocker.release();
      await consumed;
    }
  });

  it('preserves acceptance after a lost database commit acknowledgement, with no second send', async () => {
    const original = repository.markOtpAccepted.bind(repository);
    const spy = jest.spyOn(repository, 'markOtpAccepted').mockImplementationOnce(async (...args) => {
      await original(...args); throw new Error('lost commit acknowledgement');
    });
    const sms = { sendOtp: jest.fn(async (message: OtpSms) =>
      ({ transactionId: `tx-${message.deliveryId}`, messageId: `msg-${message.deliveryId}` })) };
    const service = new OtpService(config as never, repository, sms), key = randomUUID();
    try {
      await expect(service.send(phone, key)).rejects.toMatchObject({ code: 'otp_delivery_unknown' });
      await expect(service.send(phone, key)).resolves.toHaveProperty('message');
      expect(sms.sendOtp).toHaveBeenCalledTimes(1);
      expect((await repository.statusSnapshot()).states).toMatchObject({ accepted: 1, failed: 0 });
    } finally { spy.mockRestore(); }
  });

  it('exposes bounded aggregate state and local observation latencies without identifiers', async () => {
    const accepted = await begin(), failed = await begin(), unknown = await begin(), sent = await begin();
    await accept(accepted.id);
    await repository.markOtpOutcome(failed.id, phoneHash, 'failed', 'provider_rejected');
    await repository.markOtpOutcome(unknown.id, phoneHash, 'unknown', 'provider_network_error');
    await repository.applySmsEvent(event(sent.id));
    const snapshot = await repository.statusSnapshot();
    expect(snapshot).toMatchObject({ states: { pending: 0, accepted: 1, failed: 1, unknown: 1, sent: 1 },
      awaiting_callback: 1, handset_delivery: 'not_confirmed', retention: 'otp_expiry',
      average_acceptance_ms: expect.any(Number), average_sent_callback_ms: expect.any(Number), average_failure_ms: expect.any(Number) });
    expect(JSON.stringify(snapshot)).not.toContain(phoneHash);
    expect(JSON.stringify(snapshot)).not.toContain(sent.id);
  });

  it.each(['timeout', 'disconnect'] as const)('recovers after a real loopback HTTP %s without a duplicate POST', async failure => {
    const received: Record<string, unknown>[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{"transaction_id":');
        if (failure === 'disconnect') response.destroy();
        // Otherwise leave the receipt incomplete until the real fetch deadline expires.
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const localConfig = { ...config, sms: { ...config.sms, apiKey: 'synthetic-local-only', timeoutMillis: 500,
        endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/send` } };
      const service = new OtpService(localConfig as never, repository, new SweegoSmsService(localConfig as never));
      const key = randomUUID();
      await expect(service.send(phone, key)).rejects.toMatchObject({ code: 'otp_delivery_unknown' });
      expect(received).toHaveLength(1);
      const payload = received[0]!;
      const delivered: OtpSms = { phone, region: 'FR', deliveryId: String(payload['campaign-id']),
        code: /code de verification est ([0-9]{6})/.exec(String(payload['message-txt']))![1]! };
      expect(await row(delivered.deliveryId)).toMatchObject({ delivery_status: 'unknown' });
      await callback(delivered);
      await expect(service.send(phone, key)).resolves.toHaveProperty('message');
      await expect(service.consume(phone, delivered.code)).resolves.toHaveProperty('phoneHash', phoneHash);
      expect(received).toHaveLength(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
