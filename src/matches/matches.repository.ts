import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Queryable } from '../database/database.service';
import { DatabaseService } from '../database/database.service';
import type { KeysetCursor } from '../common/pagination';
import type {
  ContinuationResult,
  CursorMatchRow,
  CursorMessageRow,
  EffectivePlan,
  MaintenanceResult,
  MatchCommandResult,
  MatchRow,
  MatchState,
  MessageCreationResult,
  MessageRead,
  MessageRow,
  UserMatchRow,
} from './matches.models';

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

  async listDetailedForUser(userId: string, limit: number, offset: number, cursor?: KeysetCursor): Promise<UserMatchRow[]> {
    return (await this.database.query<UserMatchRow>(`
      SELECT match_record.id, match_record.user1_id, match_record.user2_id, match_record.status,
        match_record.expires_at, match_record.purge_after, match_record.continuation_initiator_id,
        match_record.created_at, match_record.last_message_at,
        other_profile.user_id AS other_user_id,
        other_profile.firstname AS other_firstname,
        date_part('year', age(current_date, other_profile.birthdate))::integer AS other_age,
        other_profile.sex AS other_sex,
        other_profile.bio AS other_bio,
        CASE WHEN COALESCE(my_state.revealed, false) AND COALESCE(other_state.revealed, false)
          THEN other_profile.photo ELSE NULL END AS other_photo,
        COALESCE(other_traits.names, ARRAY[]::text[]) AS other_traits,
        COALESCE(my_state.revealed, false) AS my_revealed,
        COALESCE(my_state.revealed, false) AND COALESCE(other_state.revealed, false) AS photos_revealed,
        COALESCE(my_state.continued, false) AS my_continued,
        COALESCE(unread.count, 0)::integer AS unread_count,
        latest.id AS last_message_id,
        latest.sender_id AS last_message_sender_id,
        latest.content AS last_message_content,
        latest.created_at AS last_message_created_at,
        latest.read_at AS last_message_read_at,
        to_char(COALESCE(match_record.last_message_at, match_record.created_at) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM match_init AS match_record
      JOIN user_profile AS other_profile
        ON other_profile.user_id = CASE WHEN match_record.user1_id = $1 THEN match_record.user2_id ELSE match_record.user1_id END
      LEFT JOIN match_state AS my_state
        ON my_state.match_id = match_record.id AND my_state.user_id = $1
      LEFT JOIN match_state AS other_state
        ON other_state.match_id = match_record.id AND other_state.user_id = other_profile.user_id
      LEFT JOIN LATERAL (
        SELECT array_agg(trait.name ORDER BY trait.name) AS names
        FROM user_trait JOIN trait ON trait.id = user_trait.trait_id
        WHERE user_trait.user_id = other_profile.user_id
      ) AS other_traits ON true
      LEFT JOIN LATERAL (
        SELECT message.id, message.sender_id, message.content, message.created_at, message.read_at
        FROM chat_message AS message
        WHERE message.match_id = match_record.id
        ORDER BY message.created_at DESC, message.id DESC
        LIMIT 1
      ) AS latest ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::integer AS count
        FROM chat_message AS message
        WHERE message.match_id = match_record.id AND message.sender_id <> $1 AND message.read_at IS NULL
      ) AS unread ON true
      WHERE (match_record.user1_id = $1 OR match_record.user2_id = $1)
        AND match_record.status <> 'ended'
        AND NOT EXISTS (
          SELECT 1 FROM user_block
          WHERE (blocker_id = $1 AND blocked_id IN (match_record.user1_id, match_record.user2_id))
             OR (blocked_id = $1 AND blocker_id IN (match_record.user1_id, match_record.user2_id))
        )
        AND ($4::timestamptz IS NULL OR
          (COALESCE(match_record.last_message_at, match_record.created_at), match_record.id) < ($4::timestamptz, $5::uuid))
      ORDER BY COALESCE(match_record.last_message_at, match_record.created_at) DESC, match_record.id DESC
      LIMIT $2 OFFSET $3
    `, [userId, limit, offset, cursor?.at ?? null, cursor?.id ?? null])).rows;
  }

  async logAdminMatchAccess(userId: string, adminId: string, adminRole: string, reason: string): Promise<boolean> {
    const result = await this.database.query(`
      INSERT INTO data_access_log (accessed_user_id, accessor_id, accessor_role, action, reason)
      SELECT account.user_id, $2, $3, 'view_matches', $4
      FROM user_account AS account WHERE account.user_id = $1 AND account.deleted_at IS NULL
    `, [userId, adminId, adminRole, reason]);
    return result.rowCount === 1;
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

  async createMessage(
    messageId: string,
    matchId: string,
    senderId: string,
    content: string,
    idempotencyKey: string,
  ): Promise<MessageCreationResult> {
    return this.database.transaction(async (client) => {
      const replay = await this.findIdempotentMessage(client, senderId, idempotencyKey);
      if (replay) {
        if (replay.message.match_id !== matchId || replay.message.content !== content) {
          return { ok: false, reason: 'idempotency_conflict' };
        }
        return { ok: true, value: { ...replay, created: false } };
      }
      const available = await this.lockMessagingMatch(client, matchId, senderId);
      if (!available.ok) return available;
      const inserted = await client.query<MessageRow>(`
        INSERT INTO chat_message (id, match_id, sender_id, content, idempotency_key, created_at)
        VALUES ($1, $2, $3, $4, $5, clock_timestamp())
        ON CONFLICT (sender_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
        RETURNING id, match_id, sender_id, content, created_at, read_at
      `, [messageId, matchId, senderId, content, idempotencyKey]);
      if (!inserted.rows[0]) {
        const concurrentReplay = await this.findIdempotentMessage(client, senderId, idempotencyKey);
        if (!concurrentReplay || concurrentReplay.message.match_id !== matchId || concurrentReplay.message.content !== content) {
          return { ok: false, reason: 'idempotency_conflict' };
        }
        return { ok: true, value: { ...concurrentReplay, created: false } };
      }
      const message = inserted.rows[0];
      await client.query('UPDATE match_init SET last_message_at = $2 WHERE id = $1', [matchId, message.created_at]);
      return {
        ok: true,
        value: { message, participant_ids: [available.value.user1_id, available.value.user2_id], created: true },
      };
    });
  }

  async markMessageRead(matchId: string, messageId: string, userId: string): Promise<MatchCommandResult<MessageRead | undefined>> {
    return this.database.transaction(async (client) => {
      const available = await this.lockMessagingMatch(client, matchId, userId);
      if (!available.ok) return available;
      const updated = await client.query(`
        UPDATE chat_message SET read_at = COALESCE(read_at, clock_timestamp())
        WHERE id = $1 AND match_id = $2 AND sender_id <> $3
      `, [messageId, matchId, userId]);
      if (updated.rowCount !== 1) return { ok: true, value: undefined };
      return { ok: true, value: {
        updated_count: 1,
        participant_ids: [available.value.user1_id, available.value.user2_id],
        read_through_message_id: messageId,
      } };
    });
  }

  async markMessagesReadThrough(
    matchId: string,
    messageId: string,
    userId: string,
  ): Promise<MatchCommandResult<MessageRead | undefined>> {
    return this.database.transaction(async (client) => {
      const available = await this.lockMessagingMatch(client, matchId, userId);
      if (!available.ok) return available;
      const through = await client.query<{ id: string; created_at: Date }>(`
        SELECT id, created_at FROM chat_message WHERE id = $1 AND match_id = $2
      `, [messageId, matchId]);
      const boundary = through.rows[0];
      if (!boundary) return { ok: true, value: undefined };
      const updated = await client.query(`
        UPDATE chat_message SET read_at = COALESCE(read_at, clock_timestamp())
        WHERE match_id = $1 AND sender_id <> $2 AND read_at IS NULL
          AND (created_at, id) <= ($3::timestamptz, $4::uuid)
      `, [matchId, userId, boundary.created_at, boundary.id]);
      return { ok: true, value: {
        updated_count: updated.rowCount ?? 0,
        participant_ids: [available.value.user1_id, available.value.user2_id],
        read_through_message_id: messageId,
      } };
    });
  }

  async participantIds(matchId: string, userId: string): Promise<[string, string] | undefined> {
    const row = (await this.database.query<Pick<MatchRow, 'user1_id' | 'user2_id'>>(`
      SELECT user1_id, user2_id FROM match_init
      WHERE id = $1 AND (user1_id = $2 OR user2_id = $2)
    `, [matchId, userId])).rows[0];
    return row ? [row.user1_id, row.user2_id] : undefined;
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

  private async findIdempotentMessage(
    client: PoolClient,
    senderId: string,
    idempotencyKey: string,
  ): Promise<{ message: MessageRow; participant_ids: [string, string] } | undefined> {
    const row = (await client.query<MessageRow & Pick<MatchRow, 'user1_id' | 'user2_id'>>(`
      SELECT message.id, message.match_id, message.sender_id, message.content, message.created_at, message.read_at,
        match_record.user1_id, match_record.user2_id
      FROM chat_message AS message
      JOIN match_init AS match_record ON match_record.id = message.match_id
      WHERE message.sender_id = $1 AND message.idempotency_key = $2
    `, [senderId, idempotencyKey])).rows[0];
    if (!row) return undefined;
    return {
      message: {
        id: row.id,
        match_id: row.match_id,
        sender_id: row.sender_id,
        content: row.content,
        created_at: row.created_at,
        read_at: row.read_at,
      },
      participant_ids: [row.user1_id, row.user2_id],
    };
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
