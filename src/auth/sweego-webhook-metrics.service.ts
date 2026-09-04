import { Injectable } from '@nestjs/common';

export type SmsWebhookOutcome = 'applied' | 'ignored' | 'conflict' | 'invalid_signature' | 'invalid_event' | 'unavailable' | 'disabled';

@Injectable()
export class SweegoWebhookMetricsService {
  private readonly counts: Record<SmsWebhookOutcome, number> = {
    applied: 0, ignored: 0, conflict: 0, invalid_signature: 0, invalid_event: 0, unavailable: 0, disabled: 0,
  };
  record(outcome: SmsWebhookOutcome): void { this.counts[outcome]++; }
  snapshot(): Record<SmsWebhookOutcome, number> { return { ...this.counts }; }
}
