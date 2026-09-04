import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import type { OtpSms, SmsDeliveryReceipt } from './sms-delivery';
import { MAX_SMS_PROVIDER_BODY_BYTES, SmsDelivery, SmsDeliveryError, smsProviderIdentifier } from './sms-delivery';
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
    if (this.config.sms.provider !== 'sweego') throw new SmsDeliveryError('not_configured', 'failed');

    let response: Response;
    try {
      response = await fetch(this.config.sms.endpoint, {
        method: 'POST',
        redirect: 'error',
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
    } catch {
      throw new SmsDeliveryError('provider_network_error', 'unknown');
    }

    if (response.status !== 200) {
      try {
        await response.body?.cancel();
      } catch {
        // The provider status remains the useful, stable failure reason.
      }
      const rejected = [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(response.status);
      throw new SmsDeliveryError(rejected ? 'provider_rejected' : 'provider_unavailable', rejected ? 'failed' : 'unknown');
    }

    let payload: unknown;
    try {
      payload = await boundedResponse(response);
    } catch {
      throw new SmsDeliveryError('provider_invalid_response', 'unknown');
    }
    if (!isSweegoSuccess(payload)) throw new SmsDeliveryError('provider_invalid_response', 'unknown');

    const messageIds = Object.values(payload.swg_uids);
    if (messageIds.length !== 1 || !messageIds[0]) throw new SmsDeliveryError('provider_invalid_response', 'unknown');
    return { transactionId: payload.transaction_id, messageId: messageIds[0] };
  }
}

function isSweegoSuccess(value: unknown): value is SweegoSuccess {
  if (!isRecord(value)) return false;
  const candidate = value as Partial<SweegoSuccess>;
  return smsProviderIdentifier(candidate.transaction_id)
    && isRecord(candidate.swg_uids)
    && Object.values(candidate.swg_uids).every(smsProviderIdentifier);
}

async function boundedResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Empty SMS response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SMS_PROVIDER_BODY_BYTES) throw new Error('Oversized SMS response');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    try { await reader.cancel(); } catch { /* Never retain provider errors. */ }
    reader.releaseLock();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatMinutes(ttlMillis: number): string {
  const minutes = ttlMillis / 60_000;
  return Number.isInteger(minutes) ? String(minutes) : String(Math.ceil(minutes));
}
