import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export type ErasureStep = 'stripe' | 'photos' | 'scylla' | 'postgres' | 'completed';
export type ClaimedErasure = { request_id: string; user_id: string; step: ErasureStep; scylla_partition: number };

@Injectable()
export class ErasureRepository {
  constructor(private readonly database: DatabaseService) {}

  async claimed(eventId: string, workerId: string): Promise<ClaimedErasure | undefined> {
    return (await this.database.query<ClaimedErasure>(`
      SELECT erasure.request_id, erasure.user_id, erasure.step, erasure.scylla_partition
      FROM account_erasure erasure JOIN outbox_event event ON event.aggregate_id = erasure.request_id
      WHERE event.id = $1 AND event.event_type = 'account.erase'
        AND event.status = 'processing' AND event.locked_by = $2
    `, [eventId, workerId])).rows[0];
  }

  async advance(eventId: string, workerId: string, current: ClaimedErasure, next: ErasureStep, partition = current.scylla_partition): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const owned = await client.query(`SELECT id FROM outbox_event
        WHERE id = $1 AND status = 'processing' AND locked_by = $2 FOR UPDATE`, [eventId, workerId]);
      if (!owned.rows[0]) return false;
      const expected = await client.query(`SELECT request_id FROM account_erasure
        WHERE request_id = $1 AND step = $2 AND scylla_partition = $3 FOR UPDATE`,
      [current.request_id, current.step, current.scylla_partition]);
      if (!expected.rows[0]) return false;
      if (next === 'completed') {
        // Messaging locks a match before its accounts. Preserve that order during
        // final redaction; the initial freeze itself never takes a match lock.
        await client.query(`SELECT id FROM match_init WHERE user1_id = $1 OR user2_id = $1
          ORDER BY id FOR UPDATE`, [current.user_id]);
        await client.query('SELECT user_id FROM user_account WHERE user_id = $1 FOR UPDATE', [current.user_id]);
        const request = await client.query(`SELECT id FROM data_subject_request
          WHERE id = $1 AND user_id = $2 AND status = 'in_progress' AND type = 'erasure' FOR UPDATE`,
        [current.request_id, current.user_id]);
        if (!request.rows[0] || current.step !== 'postgres') throw new Error('erasure_invalid_state');
        const photos = await client.query('SELECT 1 FROM user_photo WHERE user_id = $1 LIMIT 1', [current.user_id]);
        if (photos.rows[0]) throw new Error('erasure_photos_remaining');
        await client.query('DELETE FROM photo_upload_request WHERE user_id = $1', [current.user_id]);
        await client.query('DELETE FROM admin_session WHERE user_id = $1', [current.user_id]);
        await client.query('DELETE FROM admin_webauthn_challenge WHERE user_id = $1', [current.user_id]);
        await client.query('DELETE FROM admin_webauthn_bootstrap WHERE user_id = $1', [current.user_id]);
        await client.query('DELETE FROM admin_webauthn_credential WHERE user_id = $1', [current.user_id]);
        await client.query('SELECT fct_anonymize_user($1)', [current.user_id]);
        await client.query(`UPDATE data_subject_request SET status = 'completed', completed_at = clock_timestamp()
          WHERE id = $1 AND status = 'in_progress'`, [current.request_id]);
      }
      await client.query(`UPDATE account_erasure SET step = $2, scylla_partition = $3,
        updated_at = clock_timestamp(), completed_at = CASE WHEN $2 = 'completed' THEN clock_timestamp() END
        WHERE request_id = $1 AND step = $4 AND scylla_partition = $5`,
      [current.request_id, next, partition, current.step, current.scylla_partition]);
      if (next !== 'completed') await client.query(`UPDATE outbox_event SET status = 'pending', attempts = 0,
        available_at = clock_timestamp() + interval '1 second', locked_at = NULL, locked_by = NULL, last_error_code = NULL
        WHERE id = $1 AND locked_by = $2`, [eventId, workerId]);
      return true;
    });
  }

  async defer(eventId: string, workerId: string): Promise<void> {
    await this.database.query(`UPDATE outbox_event SET status = 'pending', attempts = GREATEST(0, attempts - 1),
      available_at = clock_timestamp() + interval '5 seconds', locked_at = NULL, locked_by = NULL
      WHERE id = $1 AND status = 'processing' AND locked_by = $2`, [eventId, workerId]);
  }
}
