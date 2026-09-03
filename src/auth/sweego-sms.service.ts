import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import type { OtpSms, SmsDeliveryReceipt } from './sms-delivery';
import { SmsDelivery, SmsDeliveryError } from './sms-delivery';
import { OperationalMetricsService } from '../operations/operational-metrics.service';

type SweegoSuccess = {
  transaction_id: string;
  swg_uids: Record<string, string>;
};

@Injectable()
export class SweegoSmsService extends SmsDelivery {
  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly metrics?: OperationalMetricsService,
  ) {
    super();
  }

  async sendOtp(message: OtpSms): Promise<SmsDeliveryReceipt> {
    const operation = () => this.deliver(message);
    return this.metrics?.measure('sweego', operation) ?? operation();
  }

  private async deliver(message: OtpSms): Promise<SmsDeliveryReceipt> {
    if (this.config.sms.provider !== 'sweego') throw new SmsDeliveryError('not_configured');

    let response: Response;
    try {
      response = await fetch(this.config.sms.endpoint, {
        method: 'POST',
        headers: {
          'Api-Key': this.config.sms.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: 'sms',
          provider: 'sweego',
          'campaign-type': 'transac',
          'campaign-id': message.deliveryId,
          'sender-id': this.config.sms.senderId,
          recipients: [{ num: message.phone, region: message.region }],
          'message-txt': `Histae : votre code de verification est ${message.code}. Il expire dans ${formatMinutes(this.config.sms.otpTtlMillis)} minutes.`,
          'shorten-urls': false,
          'shorten-with-protocol': false,
        }),
        signal: AbortSignal.timeout(this.config.sms.timeoutMillis),
      });
    } catch (error) {
      throw new SmsDeliveryError('provider_network_error', error);
    }

    if (response.status !== 200) {
      try {
        await response.body?.cancel();
      } catch {
        // The provider status remains the useful, stable failure reason.
      }
      throw new SmsDeliveryError(`provider_http_${response.status}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new SmsDeliveryError('provider_invalid_response', error);
    }
    if (!isSweegoSuccess(payload)) throw new SmsDeliveryError('provider_invalid_response');

    const messageIds = Object.values(payload.swg_uids);
    if (messageIds.length !== 1 || !messageIds[0]) throw new SmsDeliveryError('provider_invalid_response');
    return { transactionId: payload.transaction_id, messageId: messageIds[0] };
  }
}

function isSweegoSuccess(value: unknown): value is SweegoSuccess {
  if (!isRecord(value)) return false;
  const candidate = value as Partial<SweegoSuccess>;
  return typeof candidate.transaction_id === 'string'
    && candidate.transaction_id.trim().length > 0
    && isRecord(candidate.swg_uids)
    && Object.values(candidate.swg_uids).every((id) => typeof id === 'string' && id.trim().length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatMinutes(ttlMillis: number): string {
  const minutes = ttlMillis / 60_000;
  return Number.isInteger(minutes) ? String(minutes) : String(Math.ceil(minutes));
}
