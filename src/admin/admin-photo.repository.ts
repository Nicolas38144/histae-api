import { Injectable } from '@nestjs/common';
import type { KeysetCursor } from '../common/pagination';
import { DatabaseService } from '../database/database.service';
import type { OutboxStatus } from '../outbox/outbox.models';
import { OutboxRepository } from '../outbox/outbox.repository';
import { recordAdminAudit } from './admin-audit';
import type { AdminPhotoReconciliationRow, PhotoReconciliationFilter, PhotoReconciliationResult } from './admin.models';

@Injectable()
export class AdminPhotoRepository {
  constructor(private readonly database: DatabaseService, private readonly outbox: OutboxRepository) {}

  async listPhotoReconciliation(
    filter: PhotoReconciliationFilter,
    staleBefore: Date,
    limit: number,
    offset: number,
    cursor: KeysetCursor | undefined,
  ): Promise<AdminPhotoReconciliationRow[]> {
    return (await this.database.query<AdminPhotoReconciliationRow>(`
      SELECT photo.id, photo.user_id, photo.status, photo.size_bytes,
        photo.width, photo.height, photo.created_at, photo.updated_at,
        event.status AS outbox_status, event.attempts AS outbox_attempts,
        event.available_at AS outbox_available_at,
        event.locked_at AS outbox_locked_at,
        event.last_error_code AS outbox_last_error_code,
        CASE
          WHEN photo.status IN ('pending', 'processing') THEN 'stale_processing'
          WHEN event.status = 'dead_letter' THEN 'deletion_dead_letter'
          WHEN event.status = 'processing' THEN 'deletion_processing'
          WHEN event.status = 'pending' AND event.attempts > 0 THEN 'deletion_retry_scheduled'
          WHEN event.status = 'pending' THEN 'deletion_queued'
            WHEN event.status = 'completed' THEN 'deletion_event_completed'
            WHEN event.status = 'discarded' THEN 'deletion_event_discarded'
          ELSE 'deletion_event_missing'
        END AS issue,
        to_char(photo.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM user_photo AS photo
      LEFT JOIN outbox_event AS event
        ON event.event_type = 'photo.delete' AND event.aggregate_id = photo.id
      WHERE (
          (photo.status IN ('pending', 'processing') AND photo.updated_at <= $1)
          OR photo.status = 'deleting'
        )
        AND ($2 = 'all'
          OR ($2 = 'stale_processing' AND photo.status IN ('pending', 'processing'))
          OR ($2 = 'deleting' AND photo.status = 'deleting')
          OR ($2 = 'dead_letter' AND photo.status = 'deleting' AND event.status = 'dead_letter'))
        AND ($5::timestamptz IS NULL
          OR (photo.updated_at, photo.id) < ($5::timestamptz, $6::uuid))
      ORDER BY photo.updated_at DESC, photo.id DESC
      LIMIT $3 OFFSET $4
    `, [staleBefore, filter, limit, offset, cursor?.at ?? null, cursor?.id ?? null])).rows;
  }

  async reconcilePhoto(
    photoId: string,
    photoStaleBefore: Date,
    outboxStaleBefore: Date,
    adminId: string,
    adminRole: 'admin' | 'superadmin',
    reason: string,
  ): Promise<PhotoReconciliationResult> {
    return this.database.transaction(async (client) => {
      const photo = (await client.query<{
        user_id: string;
        status: 'pending' | 'processing' | 'ready' | 'deleting';
        updated_at: Date;
      }>(`
        SELECT user_id, status, updated_at
        FROM user_photo
        WHERE id = $1
        FOR UPDATE
      `, [photoId])).rows[0];
      if (!photo) return 'not_found';
      if (photo.status === 'ready'
        || (photo.status !== 'deleting' && photo.updated_at > photoStaleBefore)) {
        return 'not_actionable';
      }

      const event = (await client.query<{
        status: OutboxStatus;
        locked_at: Date | null;
      }>(`
        SELECT status, locked_at
        FROM outbox_event
        WHERE event_type = 'photo.delete' AND aggregate_id = $1
        FOR UPDATE
      `, [photoId])).rows[0];
      if (event?.status === 'processing'
        && event.locked_at !== null
        && event.locked_at > outboxStaleBefore) {
        return 'already_processing';
      }

      await client.query(`
        UPDATE user_photo
        SET status = 'deleting', updated_at = clock_timestamp()
        WHERE id = $1
      `, [photoId]);
      await this.outbox.requeue(client, {
        eventType: 'photo.delete',
        aggregateId: photoId,
      });
      await recordAdminAudit(
        client,
        photo.user_id,
        adminId,
        adminRole,
        'admin_reconcile_photo',
        reason,
      );
      return 'queued';
    });
  }

}
