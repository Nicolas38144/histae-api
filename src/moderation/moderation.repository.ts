import { Injectable } from '@nestjs/common';
import type { KeysetCursor } from '../common/pagination';
import { DatabaseService, type Queryable } from '../database/database.service';
import { OutboxRepository } from '../outbox/outbox.repository';
import type {
  ModerationCaseRow,
  ModerationContentType,
  ModerationDetailRow,
  ModerationReviewInput,
  ModerationReviewResult,
  ModerationStatus,
} from './moderation.models';

type AdminRole = 'admin' | 'superadmin';

@Injectable()
export class ModerationRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: OutboxRepository,
  ) {}

  async list(
    status: ModerationStatus | undefined,
    contentType: ModerationContentType | undefined,
    limit: number,
    offset: number,
    cursor: KeysetCursor | undefined,
  ): Promise<ModerationCaseRow[]> {
    return (await this.database.query<ModerationCaseRow>(`
      SELECT moderation.id, moderation.user_id, profile.firstname,
        moderation.content_type, moderation.status, moderation.reason_codes,
        moderation.policy_version, moderation.version, moderation.face_count,
        moderation.sharpness_score, moderation.nsfw_score,
        moderation.face_detectable, moderation.sharp_enough,
        moderation.content_allowed, moderation.review_reason,
        moderation.reviewed_at, moderation.reviewed_by,
        moderation.created_at, moderation.updated_at,
        to_char(moderation.updated_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM content_moderation_case AS moderation
      LEFT JOIN user_profile AS profile ON profile.user_id = moderation.user_id
      WHERE ($1::text IS NULL OR moderation.status = $1)
        AND ($2::text IS NULL OR moderation.content_type = $2)
        AND ($5::timestamptz IS NULL OR
          (moderation.updated_at, moderation.id) < ($5::timestamptz, $6::uuid))
      ORDER BY moderation.updated_at DESC, moderation.id DESC
      LIMIT $3 OFFSET $4
    `, [status ?? null, contentType ?? null, limit, offset, cursor?.at ?? null, cursor?.id ?? null])).rows;
  }

  async detail(
    caseId: string,
    adminId: string,
    adminRole: AdminRole,
    reason: string,
  ): Promise<ModerationDetailRow | undefined> {
    return this.database.transaction(async (client) => {
      const row = (await client.query<ModerationDetailRow>(`
        SELECT moderation.id, moderation.user_id, profile.firstname,
          moderation.content_type, moderation.status, moderation.reason_codes,
          moderation.policy_version, moderation.version, moderation.face_count,
          moderation.sharpness_score, moderation.nsfw_score,
          moderation.face_detectable, moderation.sharp_enough,
          moderation.content_allowed, moderation.review_reason,
          moderation.reviewed_at, moderation.reviewed_by,
          moderation.created_at, moderation.updated_at,
          CASE moderation.content_type
            WHEN 'bio' THEN bio.bio
            WHEN 'profile_answer' THEN answer.answer
            ELSE NULL
          END AS text_content,
          question.prompt AS question,
          photo.object_key,
          to_char(moderation.updated_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
        FROM content_moderation_case AS moderation
        LEFT JOIN user_profile AS profile ON profile.user_id = moderation.user_id
        LEFT JOIN user_profile AS bio ON bio.user_id = moderation.bio_user_id
        LEFT JOIN user_profile_answer AS answer ON answer.id = moderation.profile_answer_id
        LEFT JOIN profile_question AS question ON question.id = answer.question_id
        LEFT JOIN user_photo AS photo ON photo.id = moderation.photo_id
        WHERE moderation.id = $1
      `, [caseId])).rows[0];
      if (!row) return undefined;
      await this.recordAudit(client, row.user_id, adminId, adminRole, 'view_moderation_content', reason);
      return row;
    });
  }

  async review(
    caseId: string,
    input: ModerationReviewInput,
    adminId: string,
    adminRole: AdminRole,
  ): Promise<ModerationReviewResult> {
    return this.database.transaction(async (client) => {
      const current = (await client.query<{
        user_id: string;
        content_type: ModerationContentType;
        photo_id: string | null;
        photo_status: 'pending' | 'processing' | 'ready' | 'deleting' | null;
        version: number;
      }>(`
        SELECT moderation.user_id, moderation.content_type,
          moderation.photo_id, photo.status AS photo_status, moderation.version
        FROM content_moderation_case AS moderation
        LEFT JOIN user_photo AS photo ON photo.id = moderation.photo_id
        WHERE moderation.id = $1
        FOR UPDATE OF moderation
      `, [caseId])).rows[0];
      if (!current) return 'not_found';
      if (current.version !== input.version) return 'stale';
      if (current.content_type !== 'photo' && input.photoChecks) return 'not_actionable';
      if (current.content_type === 'photo'
        && (current.photo_status !== 'ready' || !input.photoChecks)) return 'not_actionable';

      const checks = current.content_type === 'photo' ? input.photoChecks! : undefined;
      const updated = await client.query(`
        UPDATE content_moderation_case
        SET status = $2, face_detectable = $3, sharp_enough = $4,
          content_allowed = $5, reviewed_by = $6,
          reviewed_at = clock_timestamp(), review_reason = $7,
          version = version + 1, updated_at = clock_timestamp()
        WHERE id = $1 AND version = $8
      `, [
        caseId,
        input.decision,
        checks?.face_detectable ?? null,
        checks?.sharp_enough ?? null,
        checks?.content_allowed ?? null,
        adminId,
        input.reason,
        input.version,
      ]);
      if (updated.rowCount !== 1) return 'stale';

      if (current.content_type === 'photo' && input.decision === 'rejected') {
        await client.query(`
          UPDATE user_photo SET status = 'deleting', updated_at = clock_timestamp()
          WHERE id = $1 AND status = 'ready'
        `, [current.photo_id]);
        await this.outbox.requeue(client, {
          eventType: 'photo.delete',
          aggregateId: current.photo_id!,
        });
      }
      await this.recordAudit(
        client,
        current.user_id,
        adminId,
        adminRole,
        'admin_review_content',
        input.reason,
      );
      return 'updated';
    });
  }

  private async recordAudit(
    database: Queryable,
    accessedUserId: string,
    adminId: string,
    adminRole: AdminRole,
    action: 'view_moderation_content' | 'admin_review_content',
    reason: string,
  ): Promise<void> {
    await database.query(`
      INSERT INTO data_access_log (
        accessed_user_id, accessor_id, accessor_role, action, reason
      ) VALUES ($1, $2, $3, $4, $5)
    `, [accessedUserId, adminId, adminRole, action, reason]);
  }
}
