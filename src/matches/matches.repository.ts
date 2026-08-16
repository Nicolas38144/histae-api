import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Queryable } from '../database/database.service';
import { DatabaseService } from '../database/database.service';
import type { KeysetCursor } from '../common/pagination';
import type { ContinuationResult, CursorMatchRow, CursorMessageRow, EffectivePlan, MaintenanceResult, MatchCommandResult, MatchRow, MatchState, MessageRow } from './matches.models';

const MAINTENANCE_LOCK = 37_142_581;
const MATCH_PURGE_MS = 30 * 24 * 60 * 60 * 1_000;

@Injectable()
export class MatchesRepository {
  constructor(private readonly database: DatabaseService) {}

  async create(match: MatchRow): Promise<void> {
    await this.database.transaction(async (client) => {
      const inserted = await client.query(`
        INSERT INTO match_init (id, user1_id, user2_id, status, expires_at, purge_after, continuation_initiator_id, created_at, last_message_at)
        SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
        FROM user_account AS first_account
        JOIN user_account AS second_account ON second_account.user_id = $3
        WHERE first_account.user_id = $2
          AND first_account.deleted_at IS NULL AND first_account.is_banned = false
          AND second_account.deleted_at IS NULL AND second_account.is_banned = false
          AND NOT EXISTS (
          SELECT 1 FROM user_block
          WHERE (blocker_id = $2 AND blocked_id = $3) OR (blocker_id = $3 AND blocked_id = $2)
        )
      `, [match.id, match.user1_id, match.user2_id, match.status, match.expires_at, null, null, match.created_at, null]);
      if (inserted.rowCount !== 1) {
        const blocked = await client.query<{ blocked: boolean }>(`
          SELECT EXISTS (
            SELECT 1 FROM user_block
            WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)
          ) AS blocked
        `, [match.user1_id, match.user2_id]);
        throw new MatchMutationError(blocked.rows[0]?.blocked ? 'blocked' : 'not_found');
      }
      await client.query(`
        INSERT INTO match_state (match_id, user_id, revealed, continued)
        VALUES ($1, $2, false, false), ($1, $3, false, false)
      `, [match.id, match.user1_id, match.user2_id]);
    });
  }

  async findByPair(user1Id: string, user2Id: string): Promise<MatchRow | undefined> {
    return (await this.database.query<MatchRow>(`
      SELECT id, user1_id, user2_id, status, expires_at, purge_after, continuation_initiator_id, created_at, last_message_at
      FROM match_init WHERE user1_id = $1 AND user2_id = $2
    `, [user1Id, user2Id])).rows[0];
  }

  async listForUser(userId: string, limit: number, offset: number, cursor?: KeysetCursor): Promise<CursorMatchRow[]> {
    return (await this.database.query<CursorMatchRow>(`
      SELECT id, user1_id, user2_id, status, expires_at, purge_after, continuation_initiator_id, created_at, last_message_at,
        to_char(COALESCE(last_message_at, created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM match_init
      WHERE (user1_id = $1 OR user2_id = $1)
        AND status <> 'ended'
        AND NOT EXISTS (
          SELECT 1 FROM user_block
          WHERE (blocker_id = $1 AND blocked_id IN (user1_id, user2_id))
             OR (blocked_id = $1 AND blocker_id IN (user1_id, user2_id))
        )
        AND ($4::timestamptz IS NULL OR (COALESCE(last_message_at, created_at), id) < ($4::timestamptz, $5::uuid))
      ORDER BY COALESCE(last_message_at, created_at) DESC, id DESC LIMIT $2 OFFSET $3
    `, [userId, limit, offset, cursor?.at ?? null, cursor?.id ?? null])).rows;
  }

  async findForUser(matchId: string, userId: string): Promise<MatchRow | undefined> {
    return (await this.database.query<MatchRow>(`
      SELECT id, user1_id, user2_id, status, expires_at, purge_after, continuation_initiator_id, created_at, last_message_at
      FROM match_init
      WHERE
        id = $1
        AND (user1_id = $2 OR user2_id = $2)
    `, [matchId, userId])).rows[0];
  }

  async recordReveal(matchId: string, userId: string): Promise<MatchCommandResult<boolean>> {
    return this.database.transaction(async (client) => {
      const available = await this.lockMessagingMatch(client, matchId, userId);
      if (!available.ok) return available;
      const updated = await client.query(`
        UPDATE match_state SET revealed = true
        WHERE match_id = $1 AND user_id = $2
      `, [matchId, userId]);
      if (updated.rowCount !== 1) return { ok: false, reason: 'not_found' };
      const state = await client.query<{ revealed: boolean }>(`
        SELECT count(*) = 2 AND bool_and(revealed) AS revealed
        FROM match_state WHERE match_id = $1
      `, [matchId]);
      return { ok: true, value: state.rows[0]?.revealed === true };
    });
  }

  async messagesForUser(matchId: string, userId: string, limit: number, offset: number, cursor?: KeysetCursor): Promise<MatchCommandResult<CursorMessageRow[]>> {
    return this.database.transaction(async (client) => {
      const available = await this.lockMessagingMatch(client, matchId, userId);
      if (!available.ok) return available;
      const messages = await client.query<CursorMessageRow>(`
        SELECT id, match_id, sender_id, content, created_at, read_at,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
        FROM chat_message
        WHERE match_id = $1
          AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3
      `, [matchId, limit, offset, cursor?.at ?? null, cursor?.id ?? null]);
      return { ok: true, value: messages.rows };
    });
  }

  async createMessage(messageId: string, matchId: string, senderId: string, content: string): Promise<MatchCommandResult<MessageRow>> {
    return this.database.transaction(async (client) => {
      const available = await this.lockMessagingMatch(client, matchId, senderId);
      if (!available.ok) return available;
      const inserted = await client.query<MessageRow>(`
        INSERT INTO chat_message (id, match_id, sender_id, content, created_at)
        VALUES ($1, $2, $3, $4, clock_timestamp())
        RETURNING id, match_id, sender_id, content, created_at, read_at
      `, [messageId, matchId, senderId, content]);
      const message = inserted.rows[0]!;
      await client.query('UPDATE match_init SET last_message_at = $2 WHERE id = $1', [matchId, message.created_at]);
      return { ok: true, value: message };
    });
  }

  async markMessageRead(matchId: string, messageId: string, userId: string): Promise<MatchCommandResult<boolean>> {
    return this.database.transaction(async (client) => {
      const available = await this.lockMessagingMatch(client, matchId, userId);
      if (!available.ok) return available;
      const updated = await client.query(`
        UPDATE chat_message SET read_at = COALESCE(read_at, clock_timestamp())
        WHERE id = $1 AND match_id = $2 AND sender_id <> $3
      `, [messageId, matchId, userId]);
      return { ok: true, value: updated.rowCount === 1 };
    });
  }

  async openContinuationWindow(matchId: string, now: Date): Promise<boolean> {
    return (await this.database.query(`
      UPDATE match_init
      SET
        status = 'awaiting_continuation',
        expires_at = $2 + INTERVAL '24 hours'
      WHERE
        id = $1
        AND status = 'active'
        AND expires_at <= $2
    `, [matchId, now])).rowCount === 1;
  }

  async expireAwaitingMatch(matchId: string, now: Date): Promise<void> {
    await this.database.query(`
      UPDATE match_init 
      SET
        status = 'expired',
        purge_after = $3
      WHERE
        id = $1 
        AND status = 'awaiting_continuation'
        AND expires_at <= $2
    `, [matchId, now, new Date(now.getTime() + MATCH_PURGE_MS)]);
  }

  async effectivePlan(userId: string, now: Date, database: Queryable = this.database): Promise<EffectivePlan> {
    const result = await database.query<{ code: string; weekly_continuation_limit: number | null }>(`
      SELECT plan.code, plan.weekly_continuation_limit
      FROM subscription_plan AS plan
      WHERE plan.code = COALESCE((
        SELECT subscription.plan
        FROM user_subscription AS subscription
        WHERE
          subscription.user_id = $1
          AND (subscription.plan = 'free' OR subscription.current_period_ends_at IS NULL OR subscription.current_period_ends_at > $2)
      ), 'free')
    `, [userId, now]);
    const plan = result.rows[0];
    if (!plan) throw new Error('free subscription plan is missing');
    return { plan: plan.code, weeklyLimit: plan.weekly_continuation_limit };
  }

  async continuationUsage(userId: string, weekStart: Date): Promise<number> {
    const result = await this.database.query<{ used_count: number }>(`
      SELECT used_count
      FROM continuation_usage
      WHERE
        user_id = $1
        AND week_start = $2
    `, [userId, weekStart]);
    return result.rows[0]?.used_count ?? 0;
  }

  async recordContinuationConsent(matchId: string, userId: string): Promise<ContinuationResult> {
    return this.database.transaction(async (client) => {
      const header = await client.query<Pick<MatchRow, 'status' | 'expires_at' | 'continuation_initiator_id'>>(`
        SELECT status, expires_at, continuation_initiator_id
        FROM match_init
        WHERE id = $1 AND (user1_id = $2 OR user2_id = $2)
        FOR UPDATE
      `, [matchId, userId]);
      let match = header.rows[0];
      if (!match) return 'not_found';
      const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
      if (match.status === 'active') {
        if (new Date(match.expires_at).getTime() > now.getTime()) return 'not_available_yet';
        const opened = await client.query<Pick<MatchRow, 'status' | 'expires_at' | 'continuation_initiator_id'>>(`
          UPDATE match_init
          SET status = 'awaiting_continuation', expires_at = $2 + INTERVAL '24 hours'
          WHERE id = $1
          RETURNING status, expires_at, continuation_initiator_id
        `, [matchId, now]);
        match = opened.rows[0]!;
      }
      if (match.status !== 'awaiting_continuation') return 'invalid_state';
      if (new Date(match.expires_at).getTime() <= now.getTime()) {
        await client.query(`
          UPDATE match_init
          SET status = 'expired', purge_after = $2
          WHERE id = $1
        `, [matchId, new Date(now.getTime() + MATCH_PURGE_MS)]);
        return 'expired';
      }
      const state = await client.query<Pick<MatchState, 'continued'>>(`
        SELECT continued
        FROM match_state
        WHERE
          match_id = $1
          AND user_id = $2
        FOR UPDATE
      `, [matchId, userId]);
      if (!state.rows[0]) return 'not_found';
      if (state.rows[0].continued) return 'already_recorded';

      if (match.continuation_initiator_id === null) {
        await client.query('UPDATE match_state SET continued = true WHERE match_id = $1 AND user_id = $2', [matchId, userId]);
        await client.query('UPDATE match_init SET continuation_initiator_id = $2 WHERE id = $1', [matchId, userId]);
        return 'pending';
      }
      const plan = await this.effectivePlan(match.continuation_initiator_id, now, client);
      const weekStart = startOfUtcWeek(now);
      if (plan.weeklyLimit !== null) {
        const usage = await client.query<{ used_count: number }>(`
          INSERT INTO continuation_usage (user_id, week_start, used_count) VALUES ($1, $2, 1)
          ON CONFLICT (user_id, week_start) DO UPDATE SET used_count = continuation_usage.used_count + 1
          WHERE continuation_usage.used_count < $3 RETURNING used_count
        `, [match.continuation_initiator_id, weekStart, plan.weeklyLimit]);
        if (!usage.rows[0]) return 'quota_reached';
      }
      await client.query('UPDATE match_state SET continued = true WHERE match_id = $1 AND user_id = $2', [matchId, userId]);
      const confirmed = await client.query(`
        UPDATE match_init SET status = 'confirmed', purge_after = NULL
        WHERE id = $1 AND status = 'awaiting_continuation' AND expires_at > $2
          AND (SELECT count(*) FROM match_state WHERE match_id = $1 AND continued = true) = 2
      `, [matchId, now]);
      return confirmed.rowCount === 1 ? 'confirmed' : 'invalid_state';
    });
  }

  private async lockMessagingMatch(client: PoolClient, matchId: string, userId: string): Promise<MatchCommandResult<MatchRow>> {
    const locked = await client.query<MatchRow>(`
      SELECT id, user1_id, user2_id, status, expires_at, purge_after, continuation_initiator_id, created_at, last_message_at
      FROM match_init
      WHERE id = $1 AND (user1_id = $2 OR user2_id = $2)
      FOR UPDATE
    `, [matchId, userId]);
    let match = locked.rows[0];
    if (!match) return { ok: false, reason: 'not_found' };
    const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
    if (match.status === 'active' && new Date(match.expires_at).getTime() <= now.getTime()) {
      const opened = await client.query<MatchRow>(`
        UPDATE match_init
        SET status = 'awaiting_continuation', expires_at = $2 + INTERVAL '24 hours'
        WHERE id = $1
        RETURNING id, user1_id, user2_id, status, expires_at, purge_after, continuation_initiator_id, created_at, last_message_at
      `, [matchId, now]);
      match = opened.rows[0]!;
    }
    if (match.status === 'awaiting_continuation' && new Date(match.expires_at).getTime() <= now.getTime()) {
      await client.query(`
        UPDATE match_init SET status = 'expired', purge_after = $2
        WHERE id = $1
      `, [matchId, new Date(now.getTime() + MATCH_PURGE_MS)]);
      return { ok: false, reason: 'expired' };
    }
    if (match.status !== 'active' && match.status !== 'awaiting_continuation' && match.status !== 'confirmed') {
      return { ok: false, reason: 'invalid_state' };
    }
    return { ok: true, value: match };
  }

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

class MatchMutationError extends Error {
  constructor(readonly reason: 'not_found' | 'blocked') {
    super(reason);
  }
}

function startOfUtcWeek(now: Date): Date {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date;
}
