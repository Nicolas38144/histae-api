import { randomUUID } from 'node:crypto';
import type { Queryable } from '../database/database.service';

export type AcceptedErasure = { request_id: string; status: 'in_progress' };

/** Caller owns the transaction and locks user_account before the DSR/token. */
export async function enqueueAccountErasure(database: Queryable, userId: string, suppliedRequestId?: string): Promise<AcceptedErasure> {
  const existing = (await database.query<{ request_id: string }>(
    'SELECT request_id FROM account_erasure WHERE user_id = $1', [userId],
  )).rows[0];
  if (existing) {
    if (suppliedRequestId && existing.request_id !== suppliedRequestId) throw new Error('erasure_request_conflict');
    return { request_id: existing.request_id, status: 'in_progress' };
  }
  const requestId = suppliedRequestId ?? (await database.query<{ id: string }>(`
    INSERT INTO data_subject_request (user_id, type, status)
    VALUES ($1, 'erasure', 'in_progress')
    ON CONFLICT (user_id, type) WHERE status IN ('pending', 'in_progress')
    DO UPDATE SET status = 'in_progress'
    RETURNING id
  `, [userId])).rows[0]!.id;
  await database.query(`
    INSERT INTO account_erasure (request_id, user_id) VALUES ($1, $2)
  `, [requestId, userId]);
  await database.query(`
    INSERT INTO outbox_event (id, event_type, aggregate_id)
    VALUES ($1, 'account.erase', $2) ON CONFLICT (event_type, aggregate_id) DO NOTHING
  `, [randomUUID(), requestId]);
  await database.query('UPDATE user_account SET deleted_at = COALESCE(deleted_at, clock_timestamp()) WHERE user_id = $1', [userId]);
  await database.query('DELETE FROM account_deletion_token WHERE user_id = $1', [userId]);
  return { request_id: requestId, status: 'in_progress' };
}
