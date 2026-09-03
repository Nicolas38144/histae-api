import { Injectable } from '@nestjs/common';
import { apiError } from '../common/api-error';
import { cursorPage, decodeCursor, type CursorPage } from '../common/pagination';
import { normalizePrintableText } from '../common/normalize-printable-text';
import type { DeadLetter, OutboxOperator } from './outbox.models';
import { OutboxRepository } from './outbox.repository';

@Injectable()
export class OutboxAdminService {
  constructor(private readonly outbox: OutboxRepository) {}

  async deadLetters(limit: number, rawCursor?: string): Promise<CursorPage<DeadLetter>> {
    if (limit < 1 || limit > 100) invalidRequest();
    const rows = await this.outbox.listDeadLetters(limit + 1, decodeCursor(rawCursor));
    const page = cursorPage(rows, limit, (row) => row.dead_lettered_at);
    return {
      items: page.items.map((row) => ({
        event_id: row.id,
        event_type: row.event_type,
        attempts: row.attempts,
        last_error_code: row.last_error_code,
        created_at: row.created_at,
        dead_lettered_at: row.dead_lettered_at,
      })),
      next_cursor: page.next_cursor,
    };
  }

  retry(eventId: string, operator: OutboxOperator, rawReason: string): Promise<void> {
    return this.resolve(eventId, operator, rawReason, 'retry');
  }

  discard(eventId: string, operator: OutboxOperator, rawReason: string): Promise<void> {
    return this.resolve(eventId, operator, rawReason, 'discard');
  }

  private async resolve(
    eventId: string,
    operator: OutboxOperator,
    rawReason: string,
    action: 'retry' | 'discard',
  ): Promise<void> {
    const reason = normalizeReason(rawReason);
    const result = action === 'retry'
      ? await this.outbox.retryDeadLetter(eventId, operator, reason)
      : await this.outbox.discardDeadLetter(eventId, operator, reason);
    if (result === 'updated') return;
    if (result === 'not_found') {
      throw apiError(404, 'outbox_event_not_found', 'The outbox event could not be found.');
    }
    if (result === 'not_dead_letter') {
      throw apiError(409, 'outbox_event_not_dead_letter', 'The outbox event is no longer a dead letter.');
    }
    throw apiError(409, 'outbox_discard_not_allowed', 'The outbox event cannot be safely discarded.');
  }
}

function normalizeReason(value: string): string {
  const reason = normalizePrintableText(value, { minLength: 3, maxLength: 500 });
  if (!reason) invalidRequest();
  return reason;
}

function invalidRequest(): never {
  throw apiError(400, 'invalid_outbox_request', 'The outbox administrator request is invalid.');
}
