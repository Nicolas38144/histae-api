import type { SmsFailureReason } from './otp-delivery.models';

export const MAX_SMS_PROVIDER_BODY_BYTES = 16_384;

export function smsProviderIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export type OtpSms = {
  phone: string;
  region: string;
  code: string;
  deliveryId: string;
};

export type SmsDeliveryReceipt = {
  transactionId: string;
  messageId: string;
};

export abstract class SmsDelivery {
  abstract sendOtp(message: OtpSms): Promise<SmsDeliveryReceipt>;
}

export class SmsDeliveryError extends Error {
  constructor(public readonly reason: SmsFailureReason, public readonly outcome: 'failed' | 'unknown') {
    super('SMS delivery failed');
    this.name = 'SmsDeliveryError';
  }
}
