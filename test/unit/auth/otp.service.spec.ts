import { hmacSha256 } from '../../../src/crypto/phone-crypto';
import { OtpService } from '../../../src/auth/otp.service';
import { SmsDeliveryError } from '../../../src/auth/sms-delivery';

describe('OtpService', () => {
  const config = {
    phone: { hashKey: 'h'.repeat(32) },
    sms: { region: 'FR', timeoutMillis: 10_000, otpTtlMillis: 600_000 },
  };

  it('persists a pending hash, sends through the provider, then activates the OTP', async () => {
    const repository = {
      beginOtpDelivery: jest.fn().mockResolvedValue({ state: 'created', id: 'ignored' }),
      markOtpAccepted: jest.fn().mockResolvedValue(true),
      markOtpOutcome: jest.fn(),
    };
    const sms = {
      sendOtp: jest.fn().mockResolvedValue({ transactionId: 'transaction-1', messageId: 'message-1' }),
    };
    const service = new OtpService(config as never, repository as never, sms as never);
    const idempotencyKey = 'f5c3c744-a75f-46e7-8b59-6b94671cb029';

    await expect(service.send('+33 6 12 34 56 78', idempotencyKey)).resolves.toEqual({
      message: 'Verification code request accepted.',
    });

    const persisted = repository.beginOtpDelivery.mock.calls[0]?.[0] as {
      id: string;
      phoneHash: string;
      otpHash: string;
      idempotencyKey: string;
      ttlMillis: number;
      settlementMillis: number;
    };
    const delivered = sms.sendOtp.mock.calls[0]?.[0] as { phone: string; region: string; code: string; deliveryId: string };
    expect(delivered.code).toMatch(/^[0-9]{6}$/);
    expect(delivered).toEqual(expect.objectContaining({ phone: '+33612345678', region: 'FR', deliveryId: persisted.id }));
    expect(persisted).toEqual(expect.objectContaining({
      phoneHash: hmacSha256('+33612345678', config.phone.hashKey),
      otpHash: hmacSha256(delivered.code, config.phone.hashKey),
      idempotencyKey,
      ttlMillis: 600_000,
      settlementMillis: 15_000,
    }));
    expect(persisted.settlementMillis).toBeGreaterThan(config.sms.timeoutMillis);
    expect(repository.markOtpAccepted).toHaveBeenCalledWith(persisted.id, persisted.phoneHash, 'transaction-1', 'message-1');
    expect(repository.markOtpOutcome).not.toHaveBeenCalled();
  });

  it.each(['accepted', 'sent', 'pending'] as const)('replays a %s idempotency record without sending another SMS', async (state) => {
    const repository = {
      beginOtpDelivery: jest.fn().mockResolvedValue({ state, id: 'delivery-1' }),
      markOtpAccepted: jest.fn(),
      markOtpOutcome: jest.fn(),
    };
    const sms = { sendOtp: jest.fn() };
    const service = new OtpService(config as never, repository as never, sms as never);

    await expect(service.send('+33612345678', 'f5c3c744-a75f-46e7-8b59-6b94671cb029')).resolves.toEqual({
      message: 'Verification code request accepted.',
    });
    expect(sms.sendOtp).not.toHaveBeenCalled();
  });

  it('keeps a failed delivery unusable and maps the provider failure to a stable 503', async () => {
    const repository = {
      beginOtpDelivery: jest.fn().mockResolvedValue({ state: 'created', id: 'delivery-1' }),
      markOtpAccepted: jest.fn(),
      markOtpOutcome: jest.fn().mockResolvedValue('failed'),
    };
    const sms = { sendOtp: jest.fn().mockRejectedValue(new SmsDeliveryError('provider_rejected', 'failed')) };
    const service = new OtpService(config as never, repository as never, sms as never);

    await expect(service.send('+33612345678', 'f5c3c744-a75f-46e7-8b59-6b94671cb029'))
      .rejects.toEqual(expect.objectContaining({ status: 503, code: 'otp_delivery_unavailable' }));
    expect(repository.markOtpAccepted).not.toHaveBeenCalled();
    expect(repository.markOtpOutcome).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'failed', 'provider_rejected');
  });

  it('returns a stable 503 without sending when a definitive failure was recorded', async () => {
    const repository = {
      beginOtpDelivery: jest.fn().mockResolvedValue({ state: 'failed', id: 'delivery-1' }),
      markOtpAccepted: jest.fn(),
      markOtpOutcome: jest.fn(),
    };
    const sms = { sendOtp: jest.fn() };
    const service = new OtpService(config as never, repository as never, sms as never);

    await expect(service.send('+33612345678', 'f5c3c744-a75f-46e7-8b59-6b94671cb029'))
      .rejects.toEqual(expect.objectContaining({ status: 503, code: 'otp_delivery_unavailable' }));
    expect(sms.sendOtp).not.toHaveBeenCalled();
  });

  it('rejects a reused key bound to another phone and malformed keys', async () => {
    const repository = {
      beginOtpDelivery: jest.fn().mockResolvedValue({ state: 'conflict' }),
      markOtpAccepted: jest.fn(),
      markOtpOutcome: jest.fn(),
    };
    const service = new OtpService(config as never, repository as never, { sendOtp: jest.fn() } as never);

    await expect(service.send('+33612345678', undefined))
      .rejects.toEqual(expect.objectContaining({ status: 400, code: 'invalid_idempotency_key' }));
    await expect(service.send('+33612345678', 'not-a-uuid'))
      .rejects.toEqual(expect.objectContaining({ status: 400, code: 'invalid_idempotency_key' }));
    expect(repository.beginOtpDelivery).not.toHaveBeenCalled();

    await expect(service.send('+33612345678', 'f5c3c744-a75f-46e7-8b59-6b94671cb029'))
      .rejects.toEqual(expect.objectContaining({ status: 409, code: 'idempotency_key_conflict' }));
  });

  it('consumes only the matching usable hash through the repository', async () => {
    const repository = { consumeOtp: jest.fn().mockResolvedValue(true) };
    const service = new OtpService(config as never, repository as never, { sendOtp: jest.fn() } as never);

    await expect(service.consume('+33612345678', '123456')).resolves.toEqual({
      phone: '+33612345678',
      phoneHash: hmacSha256('+33612345678', config.phone.hashKey),
    });
    expect(repository.consumeOtp).toHaveBeenCalledWith(
      hmacSha256('+33612345678', config.phone.hashKey),
      hmacSha256('123456', config.phone.hashKey),
    );
  });

  it.each(['unknown', 'failed'] as const)('does not resend a persisted %s attempt', async state => {
    const sms = { sendOtp: jest.fn() };
    const repository = { beginOtpDelivery: jest.fn().mockResolvedValue({ state, id: 'delivery' }) };
    const service = new OtpService(config as never, repository as never, sms as never);
    await expect(service.send('+33600000000', 'f5c3c744-a75f-46e7-8b59-6b94671cb029'))
      .rejects.toMatchObject({ code: state === 'unknown' ? 'otp_delivery_unknown' : 'otp_delivery_unavailable' });
    expect(sms.sendOtp).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'sent'] as const)('settles a lost response according to the persisted %s state', async state => {
    const repository = { beginOtpDelivery: jest.fn().mockResolvedValue({ state: 'created' }),
      markOtpOutcome: jest.fn().mockResolvedValue(state) };
    const sms = { sendOtp: jest.fn().mockRejectedValue(new SmsDeliveryError('provider_network_error', 'unknown')) };
    const service = new OtpService(config as never, repository as never, sms as never);
    const result = service.send('+33600000000', 'f5c3c744-a75f-46e7-8b59-6b94671cb029');
    if (state === 'sent') await expect(result).resolves.toHaveProperty('message');
    else await expect(result).rejects.toMatchObject({ code: 'otp_delivery_unknown', cause: undefined });
    expect(repository.markOtpOutcome).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'unknown', 'provider_network_error');
  });

  it('never marks a provider-accepted request failed when its database acknowledgement is lost', async () => {
    const repository = { beginOtpDelivery: jest.fn().mockResolvedValue({ state: 'created' }),
      markOtpAccepted: jest.fn().mockRejectedValue(new Error('private DB detail')), markOtpOutcome: jest.fn() };
    const sms = { sendOtp: jest.fn().mockResolvedValue({ messageId: 'one', transactionId: 'two' }) };
    const service = new OtpService(config as never, repository as never, sms as never);
    await expect(service.send('+33600000000', 'f5c3c744-a75f-46e7-8b59-6b94671cb029'))
      .rejects.toMatchObject({ code: 'otp_delivery_unknown', cause: undefined });
    expect(repository.markOtpOutcome).not.toHaveBeenCalled();
  });

  it.each(['+442071838750', '+330612345678'])('rejects the non-French or malformed E.164 number %s', async (phone) => {
    const service = new OtpService(config as never, { beginOtpDelivery: jest.fn() } as never, { sendOtp: jest.fn() } as never);

    await expect(service.send(phone, 'f5c3c744-a75f-46e7-8b59-6b94671cb029'))
      .rejects.toEqual(expect.objectContaining({ status: 400, code: 'invalid_phone_number' }));
  });
});
