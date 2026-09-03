import { Injectable } from '@nestjs/common';
import { DatabaseService, type Queryable } from '../database/database.service';
import type { MaintenanceResult } from './matches.models';
import { MATCH_PURGE_MS } from './matches.constants';

const MAINTENANCE_LOCK = 37_142_581;

@Injectable()
export class MatchMaintenanceRepository {
  constructor(private readonly database: DatabaseService) {}

  async runMaintenanceAsLeader(now: Date): Promise<MaintenanceResult | undefined> {
    return this.database.transaction(async (client) => {
      const lock = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS acquired', [MAINTENANCE_LOCK]);
      if (!lock.rows[0]?.acquired) return undefined;
      return this.runMaintenance(client, now);
    });
  }

  async runMaintenance(database: Queryable, now: Date): Promise<MaintenanceResult> {
    const opened = await database.query(`
      UPDATE match_init SET status = 'awaiting_continuation', expires_at = $1 + INTERVAL '24 hours'
      WHERE status = 'active' AND expires_at <= $1
    `, [now]);
    const expired = await database.query(`
      UPDATE match_init SET status = 'expired', purge_after = $2
      WHERE status = 'awaiting_continuation' AND expires_at <= $1
    `, [now, new Date(now.getTime() + MATCH_PURGE_MS)]);
    const purged = await database.query(`DELETE FROM match_init WHERE status IN ('expired', 'ended') AND purge_after <= $1`, [now]);
    return { opened: opened.rowCount ?? 0, expired: expired.rowCount ?? 0, purged: purged.rowCount ?? 0 };
  }
}
