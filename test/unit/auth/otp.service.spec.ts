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
      markOtpSent: jest.fn().mockResolvedValue(true),
      markOtpFailed: jest.fn(),
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
      expiresAt: Date;
      staleBefore: Date;
    };
    const delivered = sms.sendOtp.mock.calls[0]?.[0] as { phone: string; region: string; code: string; deliveryId: string };
    expect(delivered.code).toMatch(/^[0-9]{6}$/);
    expect(delivered).toEqual(expect.objectContaining({ phone: '+33612345678', region: 'FR', deliveryId: persisted.id }));
    expect(persisted).toEqual(expect.objectContaining({
      phoneHash: hmacSha256('+33612345678', config.phone.hashKey),
      otpHash: hmacSha256(delivered.code, config.phone.hashKey),
      idempotencyKey,
      expiresAt: expect.any(Date),
      staleBefore: expect.any(Date),
    }));
    expect(persisted.staleBefore.getTime()).toBeLessThan(Date.now() - config.sms.timeoutMillis);
    expect(repository.markOtpSent).toHaveBeenCalledWith(persisted.id, persisted.phoneHash, 'transaction-1', 'message-1');
    expect(repository.markOtpFailed).not.toHaveBeenCalled();
  });

  it.each(['sent', 'pending'] as const)('replays a %s idempotency record without sending another SMS', async (state) => {
    const repository = {
      beginOtpDelivery: jest.fn().mockResolvedValue({ state, id: 'delivery-1' }),
      markOtpSent: jest.fn(),
      markOtpFailed: jest.fn(),
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
      markOtpSent: jest.fn(),
      markOtpFailed: jest.fn().mockResolvedValue(undefined),
    };
    const sms = { sendOtp: jest.fn().mockRejectedValue(new SmsDeliveryError('provider_http_429')) };
    const service = new OtpService(config as never, repository as never, sms as never);

    await expect(service.send('+33612345678', 'f5c3c744-a75f-46e7-8b59-6b94671cb029'))
      .rejects.toEqual(expect.objectContaining({ status: 503, code: 'otp_delivery_unavailable' }));
    expect(repository.markOtpSent).not.toHaveBeenCalled();
    expect(repository.markOtpFailed).toHaveBeenCalledWith(expect.any(String), 'provider_http_429');
  });

  it('returns a stable 503 without sending when an abandoned pending delivery was marked failed', async () => {
    const repository = {
      beginOtpDelivery: jest.fn().mockResolvedValue({ state: 'failed', id: 'delivery-1' }),
      markOtpSent: jest.fn(),
      markOtpFailed: jest.fn(),
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
      markOtpSent: jest.fn(),
      markOtpFailed: jest.fn(),
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

  it.each(['+442071838750', '+330612345678'])('rejects the non-French or malformed E.164 number %s', async (phone) => {
    const service = new OtpService(config as never, { beginOtpDelivery: jest.fn() } as never, { sendOtp: jest.fn() } as never);

    await expect(service.send(phone, 'f5c3c744-a75f-46e7-8b59-6b94671cb029'))
      .rejects.toEqual(expect.objectContaining({ status: 400, code: 'invalid_phone_number' }));
  });
});
