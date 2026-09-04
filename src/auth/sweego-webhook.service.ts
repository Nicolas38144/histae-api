import { Injectable } from '@nestjs/common';
import { apiError } from '../common/api-error';
import { ConfigService } from '../config/config.service';
import { OtpRepository } from './otp.repository';
import { sweegoDeliveryEvent } from './dto/sweego-webhook.dto';
import { verifySweegoSignature, type SweegoWebhookHeaders } from './sweego-webhook.signature';
import { SweegoWebhookMetricsService } from './sweego-webhook-metrics.service';

@Injectable()
export class SweegoWebhookService {
  constructor(private readonly config: ConfigService, private readonly repository: OtpRepository,
    private readonly metrics: SweegoWebhookMetricsService) {}

  async handle(body: Buffer | undefined, headers: SweegoWebhookHeaders): Promise<void> {
    if (this.config.sms.provider !== 'sweego' || !this.config.sms.webhookSecret) {
      this.metrics.record('disabled');
      throw apiError(503, 'sweego_webhook_unavailable', 'SMS delivery tracking is not configured.');
    }
    let raw: Buffer;
    try { raw = verifySweegoSignature(body, headers, this.config.sms.webhookSecret); }
    catch (error) { this.metrics.record('invalid_signature'); throw error; }
    let event;
    try { event = sweegoDeliveryEvent(JSON.parse(raw.toString('utf8')) as unknown, this.config.sms.senderId); }
    catch {
      this.metrics.record('invalid_event');
      throw apiError(400, 'invalid_sweego_event', 'The SMS event is invalid.');
    }
    if (!event) { this.metrics.record('ignored'); return; }
    let outcome;
    try { outcome = await this.repository.applySmsEvent(event); }
    catch {
      this.metrics.record('unavailable');
      throw apiError(503, 'sweego_webhook_unavailable', 'SMS delivery tracking is temporarily unavailable.');
    }
    this.metrics.record(outcome);
    if (outcome === 'conflict') throw apiError(409, 'sweego_delivery_conflict', 'The SMS event does not match the delivery.');
  }
}
