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
  constructor(public readonly reason: string, cause?: unknown) {
    super('SMS delivery failed', { cause });
    this.name = 'SmsDeliveryError';
  }
}
