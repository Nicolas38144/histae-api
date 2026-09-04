import { Injectable } from '@nestjs/common';
import { randomInt, randomUUID } from 'node:crypto';
import { apiError } from '../common/api-error';
import { normalizeIdempotencyKey } from '../common/idempotency';
import { ConfigService } from '../config/config.service';
import { hmacSha256 } from '../crypto/phone-crypto';
import { OtpRepository } from './otp.repository';
import { SmsDelivery, SmsDeliveryError, type SmsDeliveryReceipt } from './sms-delivery';

const DELIVERY_SETTLEMENT_GRACE_MILLIS = 5_000;

@Injectable()
export class OtpService {
  constructor(
    private readonly config: ConfigService,
    private readonly otpRepository: OtpRepository,
    private readonly smsDelivery: SmsDelivery,
  ) {}

  async send(phoneInput: string, idempotencyInput: string | undefined): Promise<{ message: string }> {
    const phone = this.normalizePhone(phoneInput, 'invalid_phone_number', 'The phone number must be a French number in E.164 format (+33).');
    const idempotencyKey = normalizeIdempotencyKey(idempotencyInput);
    const code = generateOtp();
    const phoneHash = hmacSha256(phone, this.config.phone.hashKey);
    const deliveryId = randomUUID();
    const delivery = await this.otpRepository.beginOtpDelivery({
      id: deliveryId,
      phoneHash,
      otpHash: hmacSha256(code, this.config.phone.hashKey),
      idempotencyKey,
      ttlMillis: this.config.sms.otpTtlMillis,
      settlementMillis: this.config.sms.timeoutMillis + DELIVERY_SETTLEMENT_GRACE_MILLIS,
    });

    if (delivery.state === 'conflict') {
      throw apiError(409, 'idempotency_key_conflict', 'The idempotency key was already used for another request.');
    }
    if (delivery.state === 'sent' || delivery.state === 'accepted' || delivery.state === 'pending') return accepted();
    if (delivery.state === 'unknown') throw unknownDelivery();
    if (delivery.state === 'failed') {
      throw apiError(503, 'otp_delivery_unavailable', 'The verification code could not be delivered.');
    }

    let receipt: SmsDeliveryReceipt;
    try {
      receipt = await this.smsDelivery.sendOtp({
        phone,
        region: this.config.sms.region,
        code,
        deliveryId,
      });
    } catch (error) {
      const failure = error instanceof SmsDeliveryError ? error : new SmsDeliveryError('delivery_unknown', 'unknown');
      let state;
      try {
        state = await this.otpRepository.markOtpOutcome(deliveryId, phoneHash, failure.outcome, failure.reason);
      } catch { throw unknownDelivery(); }
      // A signed callback may already have settled this attempt while /send timed out.
      if (state === 'sent' || state === 'accepted') return accepted();
      if (state === 'unknown') throw unknownDelivery();
      throw apiError(503, 'otp_delivery_unavailable', 'The verification code could not be delivered.');
    }
    let confirmed;
    try {
      confirmed = await this.otpRepository.markOtpAccepted(deliveryId, phoneHash, receipt.transactionId, receipt.messageId);
    } catch { throw unknownDelivery(); } // A DB failure after HTTP acceptance is not a provider rejection.
    if (!confirmed) throw apiError(503, 'otp_delivery_unavailable', 'The verification code could not be delivered.');
    return accepted();
  }

  normalizePhone(phoneInput: string, code: string, message: string): string {
    return normalizePhone(phoneInput, code, message);
  }

  rateLimitKey(phoneInput: string, code: string, message: string): string {
    return hmacSha256(this.normalizePhone(phoneInput, code, message), this.config.phone.hashKey);
  }

  async consume(phoneInput: string, otp: string): Promise<{ phone: string; phoneHash: string }> {
    const phone = this.normalizePhone(phoneInput, 'invalid_otp_request', 'The phone number or verification code is invalid.');
    if (!/^[0-9]{6}$/.test(otp)) throw apiError(400, 'invalid_otp_request', 'The phone number or verification code is invalid.');
    const phoneHash = hmacSha256(phone, this.config.phone.hashKey);
    const otpHash = hmacSha256(otp, this.config.phone.hashKey);
    if (!await this.otpRepository.consumeOtp(phoneHash, otpHash)) {
      throw apiError(401, 'invalid_or_expired_otp', 'The verification code is invalid or expired.');
    }
    return { phone, phoneHash };
  }
}

function accepted(): { message: string } {
  return { message: 'Verification code request accepted.' };
}

function unknownDelivery() {
  return apiError(503, 'otp_delivery_unknown', 'The verification code delivery is not yet confirmed.');
}

function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function normalizePhone(input: string, code: string, message: string): string {
  const phone = input.trim().replace(/[ .()-]/g, '');
  if (!/^\+33[1-9][0-9]{8}$/.test(phone)) {
    throw apiError(400, code, message);
  }
  return phone;
}
