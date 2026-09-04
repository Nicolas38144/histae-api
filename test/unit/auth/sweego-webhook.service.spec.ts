import { randomUUID } from 'node:crypto';
import { SweegoWebhookService } from '../../../src/auth/sweego-webhook.service';
import { SweegoWebhookMetricsService } from '../../../src/auth/sweego-webhook-metrics.service';
import { verifySweegoSignature } from '../../../src/auth/sweego-webhook.signature';
import { signSmsBody, smsEvent, sweegoSecret } from '../../helpers/sweego-fixtures';

describe('Sweego authenticated delivery callbacks', () => {
  const config = { sms: { provider: 'sweego', senderId: 'Histae', webhookSecret: sweegoSecret } };
  const repository = { applySmsEvent: jest.fn() };
  let metrics: SweegoWebhookMetricsService;
  let service: SweegoWebhookService;
  beforeEach(() => {
    repository.applySmsEvent.mockReset().mockResolvedValue('applied');
    metrics = new SweegoWebhookMetricsService();
    service = new SweegoWebhookService(config as never, repository as never, metrics);
  });
  const deliver = (event: unknown) => {
    const body = Buffer.from(JSON.stringify(event));
    return service.handle(body, signSmsBody(body));
  };

  it.each(['sms_sent', 'sms_undelivered'])('maps %s without persisting provider metadata or phone numbers', async event_type => {
    const event = smsEvent({ event_type, phone_number: '0033600000000', details: 'private provider details',
      client_id: randomUUID(), country_code: 'FR', sms_price: 0.04, nb_segments: 1,
      transaction_id: randomUUID(), send_date: '2026-09-04T11:59:59.123456' });
    await deliver(event);
    expect(repository.applySmsEvent).toHaveBeenCalledWith({ type: event_type, deliveryId: event.campaign_id,
      messageId: event.swg_uid, transactionId: event.transaction_id });
    expect(JSON.stringify(repository.applySmsEvent.mock.calls)).not.toContain('0033600000000');
    expect(metrics.snapshot().applied).toBe(1);
  });
  it('validates exact bytes, not reserialized JSON', async () => {
    const body = Buffer.from(JSON.stringify(smsEvent(), null, 2));
    const headers = signSmsBody(body);
    await expect(service.handle(body, headers)).resolves.toBeUndefined();
    await expect(service.handle(Buffer.from(JSON.stringify(JSON.parse(body.toString()))), headers))
      .rejects.toMatchObject({ code: 'invalid_sweego_signature' });
  });
  it.each(['id', 'timestamp', 'signature'] as const)('rejects missing, duplicate or forged %s headers', async key => {
    const body = Buffer.from(JSON.stringify(smsEvent()));
    for (const bad of [undefined, ['one', 'two'], 'forged']) {
      await expect(service.handle(body, { ...signSmsBody(body), [key]: bad })).rejects.toMatchObject({ status: 401 });
    }
    expect(repository.applySmsEvent).not.toHaveBeenCalled();
    expect(metrics.snapshot().invalid_signature).toBe(3);
  });
  it.each([-301_000, 61_000])('rejects signed timestamps outside the replay window (%d ms)', async delta => {
    const body = Buffer.from(JSON.stringify(smsEvent()));
    const headers = signSmsBody(body, sweegoSecret, String(Math.floor((Date.now() + delta) / 1_000)));
    await expect(service.handle(body, headers)).rejects.toMatchObject({ code: 'invalid_sweego_signature' });
  });
  it('rejects a wrong key, missing/oversized bodies and noncanonical signature encoding', () => {
    const body = Buffer.from('{}'), headers = signSmsBody(body);
    expect(() => verifySweegoSignature(body, headers, Buffer.alloc(48).toString('base64'))).toThrow();
    expect(() => verifySweegoSignature(undefined, headers, sweegoSecret)).toThrow();
    expect(() => verifySweegoSignature(Buffer.alloc(16_385), headers, sweegoSecret)).toThrow();
    expect(() => verifySweegoSignature(body, { ...headers, signature: 'a'.repeat(44) }, sweegoSecret)).toThrow();
  });
  it.each([{ test_mode: true }, { sender_id: 'Other' }, { campaign_id: 'other-campaign' }, { event_type: 'sms_clicked' }])('acknowledges out-of-scope events without activating an OTP: %p', async override => {
      await deliver(smsEvent(override));
      expect(repository.applySmsEvent).not.toHaveBeenCalled();
      expect(metrics.snapshot().ignored).toBe(1);
    });
  it.each([{ injected: true }, { test_mode: 'false' }, { event_id: 'bad-id' }, { swg_uid: 'x'.repeat(129) },
    { swg_uid: '../object' }, { channel: 'email' }, { phone_number: { nested: true } }])('rejects malformed supported DTOs: %p', async override => {
      await expect(deliver(smsEvent(override))).rejects.toMatchObject({ code: 'invalid_sweego_event' });
      expect(repository.applySmsEvent).not.toHaveBeenCalled();
    });
  it('rejects signed invalid JSON with no content in its error', async () => {
    const body = Buffer.from('{secret-private');
    await expect(service.handle(body, signSmsBody(body))).rejects.toMatchObject({ code: 'invalid_sweego_event' });
  });
  it('returns an opaque 503 on persistence failure and a stable conflict on mismatched correlation', async () => {
    repository.applySmsEvent.mockRejectedValueOnce(new Error('private SQL/phone details'));
    await expect(deliver(smsEvent())).rejects.toMatchObject({ code: 'sweego_webhook_unavailable', cause: undefined });
    repository.applySmsEvent.mockResolvedValueOnce('conflict');
    await expect(deliver(smsEvent())).rejects.toMatchObject({ code: 'sweego_delivery_conflict', status: 409 });
    expect(metrics.snapshot()).toMatchObject({ unavailable: 1, conflict: 1 });
  });
  it('fails closed when delivery tracking is not configured', async () => {
    const disabled = new SweegoWebhookService({ sms: { ...config.sms, webhookSecret: '' } } as never, repository as never, metrics);
    await expect(disabled.handle(Buffer.from('{}'), signSmsBody(Buffer.from('{}'))))
      .rejects.toMatchObject({ code: 'sweego_webhook_unavailable' });
    expect(repository.applySmsEvent).not.toHaveBeenCalled();
    expect(metrics.snapshot().disabled).toBe(1);
  });
});
