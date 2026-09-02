import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import {
  DatabaseService,
  type Queryable,
} from '../database/database.service';
import type {
  NewOutboxEvent,
  OutboxEvent,
  OutboxRetryResult,
  OutboxStatus,
} from './outbox.models';

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
        last_error_code = NULL, processed_at = NULL
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
        locked_at = NULL, locked_by = NULL, last_error_code = NULL
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
        last_error_code = $4
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
        SELECT id
        FROM outbox_event
        WHERE status = 'completed' AND processed_at <= $1
        ORDER BY processed_at, id
        LIMIT $2
      )
    `, [before, limit]);
    return result.rowCount ?? 0;
  }
}
