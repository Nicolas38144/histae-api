import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import {
  DatabaseService,
  type Queryable,
} from '../database/database.service';
import type {
  DeadLetterRow,
  NewOutboxEvent,
  OutboxEvent,
  OutboxRetryResult,
  OutboxStatus,
  OutboxOperator,
  OutboxOperatorResult,
  OutboxStatusSnapshot,
} from './outbox.models';
import type { KeysetCursor } from '../common/pagination';

@Injectable()
export class OutboxRepository {
  constructor(private readonly database: DatabaseService) {}

  async enqueue(
    database: Queryable,
    event: NewOutboxEvent,
  ): Promise<boolean> {
    const result = await database.query(`
      INSERT INTO outbox_event (id, event_type, aggregate_id, payload)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (event_type, aggregate_id) DO NOTHING
    `, [
      randomUUID(),
      event.eventType,
      event.aggregateId,
      event.payload ?? {},
    ]);
    return result.rowCount === 1;
  }

  async requeue(
    database: Queryable,
    event: NewOutboxEvent,
  ): Promise<void> {
    await database.query(`
      INSERT INTO outbox_event (id, event_type, aggregate_id, payload)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (event_type, aggregate_id) DO UPDATE
      SET status = 'pending', attempts = 0,
        available_at = clock_timestamp(), locked_at = NULL, locked_by = NULL,
        last_error_code = NULL, processed_at = NULL, dead_lettered_at = NULL,
        resolved_at = NULL, resolved_by = NULL, resolution_reason = NULL
    `, [
      randomUUID(),
      event.eventType,
      event.aggregateId,
      event.payload ?? {},
    ]);
  }

  async claimBatch(
    workerId: string,
    now: Date,
    staleBefore: Date,
    limit: number,
  ): Promise<OutboxEvent[]> {
    return (await this.database.query<OutboxEvent>(`
      WITH candidates AS (
        SELECT id
        FROM outbox_event
        WHERE (status = 'pending' AND available_at <= $2)
           OR (status = 'processing' AND locked_at <= $3)
        ORDER BY available_at, created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT $4
      )
      UPDATE outbox_event AS event
      SET status = 'processing', attempts = event.attempts + 1,
        locked_at = $2, locked_by = $1
      FROM candidates
      WHERE event.id = candidates.id
      RETURNING event.id, event.event_type AS "eventType",
        event.aggregate_id AS "aggregateId", event.payload,
        event.status, event.attempts
    `, [workerId, now, staleBefore, limit])).rows;
  }

  async complete(
    eventId: string,
    workerId: string,
    processedAt: Date,
  ): Promise<boolean> {
    const result = await this.database.query(`
      UPDATE outbox_event
      SET status = 'completed', processed_at = $3,
        locked_at = NULL, locked_by = NULL, last_error_code = NULL,
        dead_lettered_at = NULL
      WHERE id = $1 AND status = 'processing' AND locked_by = $2
    `, [eventId, workerId, processedAt]);
    return result.rowCount === 1;
  }

  async reschedule(
    eventId: string,
    workerId: string,
    availableAt: Date,
    errorCode: string,
    maxAttempts: number,
  ): Promise<OutboxRetryResult> {
    const result = await this.database.query<{ status: OutboxStatus }>(`
      UPDATE outbox_event
      SET status = CASE
          WHEN attempts >= $5 THEN 'dead_letter'
          ELSE 'pending'
        END,
        available_at = $3, locked_at = NULL, locked_by = NULL,
        last_error_code = $4,
        dead_lettered_at = CASE WHEN attempts >= $5 THEN clock_timestamp() ELSE NULL END
      WHERE id = $1 AND status = 'processing' AND locked_by = $2
      RETURNING status
    `, [eventId, workerId, availableAt, errorCode, maxAttempts]);
    const status = result.rows[0]?.status;
    if (status === 'pending' || status === 'dead_letter') return status;
    return 'not_owned';
  }

  async purgeCompleted(before: Date, limit: number): Promise<number> {
    const result = await this.database.query(`
      DELETE FROM outbox_event
      WHERE id IN (
        SELECT id FROM (
          (SELECT id, processed_at AS cleanup_at
          FROM outbox_event
          WHERE status = 'completed' AND processed_at <= $1
          ORDER BY processed_at, id
          LIMIT $2)
          UNION ALL
          (SELECT id, resolved_at AS cleanup_at
          FROM outbox_event
          WHERE status = 'discarded' AND resolved_at <= $1
          ORDER BY resolved_at, id
          LIMIT $2)
        ) AS candidates
        ORDER BY cleanup_at, id
        LIMIT $2
      )
    `, [before, limit]);
    return result.rowCount ?? 0;
  }

  async listDeadLetters(limit: number, cursor?: KeysetCursor): Promise<DeadLetterRow[]> {
    return (await this.database.query<DeadLetterRow>(`
      SELECT id, event_type, attempts, last_error_code, created_at, dead_lettered_at
      FROM outbox_event
      WHERE status = 'dead_letter'
        AND ($2::timestamptz IS NULL OR (dead_lettered_at, id) < ($2::timestamptz, $3::uuid))
      ORDER BY dead_lettered_at DESC, id DESC
      LIMIT $1
    `, [limit, cursor?.at ?? null, cursor?.id ?? null])).rows;
  }

  retryDeadLetter(
    eventId: string,
    operator: OutboxOperator,
    reason: string,
  ): Promise<OutboxOperatorResult> {
    return this.resolveDeadLetter(eventId, operator, reason, 'retry');
  }

  discardDeadLetter(
    eventId: string,
    operator: OutboxOperator,
    reason: string,
  ): Promise<OutboxOperatorResult> {
    return this.resolveDeadLetter(eventId, operator, reason, 'discard');
  }

  async statusSnapshot(): Promise<OutboxStatusSnapshot> {
    return (await this.database.query<OutboxStatusSnapshot>(`
      SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
        count(*) FILTER (WHERE status = 'processing')::int AS processing,
        count(*) FILTER (WHERE status = 'dead_letter')::int AS dead_letter,
        count(*) FILTER (WHERE status = 'discarded')::int AS discarded,
        min(available_at) FILTER (WHERE status = 'pending') AS oldest_pending_at
      FROM outbox_event
    `)).rows[0] ?? {
      pending: 0,
      processing: 0,
      dead_letter: 0,
      discarded: 0,
      oldest_pending_at: null,
    };
  }

  private async resolveDeadLetter(
    eventId: string,
    operator: OutboxOperator,
    reason: string,
    action: 'retry' | 'discard',
  ): Promise<OutboxOperatorResult> {
    return this.database.transaction(async (client) => {
      const event = (await client.query<{
        id: string;
        event_type: string;
        aggregate_id: string;
        status: OutboxStatus;
      }>(`
        SELECT id, event_type, aggregate_id, status
        FROM outbox_event WHERE id = $1 FOR UPDATE
      `, [eventId])).rows[0];
      if (!event) return 'not_found';
      if (event.status !== 'dead_letter') return 'not_dead_letter';

      if (action === 'discard') {
        if (event.event_type !== 'photo.delete') return 'discard_not_allowed';
        const photoStillExists = (await client.query(
          'SELECT 1 FROM user_photo WHERE id = $1',
          [event.aggregate_id],
        )).rows[0];
        if (photoStillExists) return 'discard_not_allowed';
      }

      await client.query(`
        INSERT INTO outbox_operator_action (
          outbox_event_id, administrator_id, administrator_role, event_type, action, reason
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `, [event.id, operator.userId, operator.role, event.event_type, action, reason]);

      if (action === 'retry') {
        await client.query(`
          UPDATE outbox_event
          SET status = 'pending', attempts = 0, available_at = clock_timestamp(),
            locked_at = NULL, locked_by = NULL, last_error_code = NULL,
            processed_at = NULL, dead_lettered_at = NULL,
            resolved_at = NULL, resolved_by = NULL, resolution_reason = NULL
          WHERE id = $1
        `, [event.id]);
      } else {
        await client.query(`
          UPDATE outbox_event
          SET status = 'discarded', locked_at = NULL, locked_by = NULL,
            processed_at = NULL, resolved_at = clock_timestamp(),
            resolved_by = $2, resolution_reason = $3
          WHERE id = $1
        `, [event.id, operator.userId, reason]);
      }
      return 'updated';
    });
  }
}
