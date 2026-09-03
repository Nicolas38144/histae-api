import type { PoolClient } from 'pg';
import type { MatchCommandResult, MatchRow } from './matches.models';
import { MATCH_PURGE_MS } from './matches.constants';

// The caller owns the transaction; expiration and the protected action stay atomic.
export async function lockMessagingMatch(client: PoolClient, matchId: string, userId: string): Promise<MatchCommandResult<MatchRow>> {
  const locked = await client.query<MatchRow & { database_now: Date }>(`
    SELECT id, user1_id, user2_id, status, expires_at, purge_after,
      continuation_initiator_id, created_at, last_message_at,
      clock_timestamp() AS database_now
    FROM match_init
    WHERE id = $1 AND (user1_id = $2 OR user2_id = $2)
    FOR UPDATE
  `, [matchId, userId]);
  const initial = locked.rows[0];
  if (!initial) return { ok: false, reason: 'not_found' };
  const now = initial.database_now;
  let match: MatchRow = initial;
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
