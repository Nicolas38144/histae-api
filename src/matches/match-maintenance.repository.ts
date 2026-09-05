import { Injectable } from '@nestjs/common';
import { DatabaseService, type Queryable } from '../database/database.service';
import type { MaintenanceBatchResult, MaintenanceResult } from './matches.models';
import { MATCH_PURGE_MS } from './matches.constants';

const MAINTENANCE_LOCK = 37_142_581;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_BATCHES = 20;

@Injectable()
export class MatchMaintenanceRepository {
  constructor(private readonly database: DatabaseService) {}

  async runMaintenanceAsLeader(
    now: Date,
    batchSize = DEFAULT_BATCH_SIZE,
    maxBatches = DEFAULT_MAX_BATCHES,
  ): Promise<MaintenanceResult | undefined> {
    return this.database.withClient(async (client) => {
      const lock = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS acquired',
        [MAINTENANCE_LOCK],
      );
      if (!lock.rows[0]?.acquired) return undefined;

      const totals = emptyMaintenanceResult();
      try {
        for (let batch = 0; batch < maxBatches; batch += 1) {
          await client.query('BEGIN');
          let result: MaintenanceBatchResult;
          try {
            result = await this.runMaintenance(client, now, batchSize);
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }

          merge(totals, result);
          totals.batches += 1;
          totals.work_remaining = batchIsFull(result, batchSize);
          if (!totals.work_remaining) break;
        }
        return totals;
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [MAINTENANCE_LOCK]);
      }
    });
  }

  async runMaintenance(
    database: Queryable,
    now: Date,
    batchSize = DEFAULT_BATCH_SIZE,
  ): Promise<MaintenanceBatchResult> {
    const opened = await database.query(`
      WITH candidates AS MATERIALIZED (
        SELECT id FROM match_init
        WHERE status = 'active' AND expires_at <= $1
        ORDER BY expires_at, id
        LIMIT $2 FOR UPDATE SKIP LOCKED
      )
      UPDATE match_init AS match_record
      SET status = 'awaiting_continuation', expires_at = $1 + INTERVAL '24 hours'
      FROM candidates WHERE match_record.id = candidates.id
    `, [now, batchSize]);
    const expired = await database.query(`
      WITH candidates AS MATERIALIZED (
        SELECT id FROM match_init
        WHERE status = 'awaiting_continuation' AND expires_at <= $1
        ORDER BY expires_at, id
        LIMIT $3 FOR UPDATE SKIP LOCKED
      )
      UPDATE match_init AS match_record
      SET status = 'expired', purge_after = $2
      FROM candidates WHERE match_record.id = candidates.id
    `, [now, new Date(now.getTime() + MATCH_PURGE_MS), batchSize]);
    const deletedMessages = await database.query(`
      WITH candidates AS MATERIALIZED (
        SELECT message.id
        FROM match_init AS match_record
        JOIN chat_message AS message ON message.match_id = match_record.id
        WHERE match_record.status IN ('expired', 'ended') AND match_record.purge_after <= $1
        ORDER BY match_record.purge_after, match_record.id, message.created_at, message.id
        LIMIT $2 FOR UPDATE OF message SKIP LOCKED
      )
      DELETE FROM chat_message AS message
      USING candidates WHERE message.id = candidates.id
    `, [now, batchSize]);
    const detachedReports = await database.query(`
      WITH candidates AS MATERIALIZED (
        SELECT report.id
        FROM match_init AS match_record
        JOIN user_report AS report ON report.match_id = match_record.id
        WHERE match_record.status IN ('expired', 'ended') AND match_record.purge_after <= $1
        ORDER BY match_record.purge_after, match_record.id, report.created_at, report.id
        LIMIT $2 FOR UPDATE OF report SKIP LOCKED
      )
      UPDATE user_report AS report
      SET match_id = NULL
      FROM candidates WHERE report.id = candidates.id
    `, [now, batchSize]);
    const purged = await database.query(`
      WITH candidates AS MATERIALIZED (
        SELECT match_record.id
        FROM match_init AS match_record
        WHERE match_record.status IN ('expired', 'ended') AND match_record.purge_after <= $1
          AND NOT EXISTS (SELECT 1 FROM chat_message WHERE match_id = match_record.id)
          AND NOT EXISTS (SELECT 1 FROM user_report WHERE match_id = match_record.id)
        ORDER BY match_record.purge_after, match_record.id
        LIMIT $2 FOR UPDATE OF match_record SKIP LOCKED
      )
      DELETE FROM match_init AS match_record
      USING candidates WHERE match_record.id = candidates.id
    `, [now, batchSize]);
    return {
      opened: opened.rowCount ?? 0,
      expired: expired.rowCount ?? 0,
      deleted_messages: deletedMessages.rowCount ?? 0,
      detached_reports: detachedReports.rowCount ?? 0,
      purged: purged.rowCount ?? 0,
    };
  }
}

function emptyMaintenanceResult(): MaintenanceResult {
  return {
    opened: 0,
    expired: 0,
    deleted_messages: 0,
    detached_reports: 0,
    purged: 0,
    batches: 0,
    work_remaining: false,
  };
}

function merge(total: MaintenanceResult, batch: MaintenanceBatchResult): void {
  total.opened += batch.opened;
  total.expired += batch.expired;
  total.deleted_messages += batch.deleted_messages;
  total.detached_reports += batch.detached_reports;
  total.purged += batch.purged;
}

function batchIsFull(result: MaintenanceBatchResult, batchSize: number): boolean {
  return Math.max(...Object.values(result)) >= batchSize;
}
