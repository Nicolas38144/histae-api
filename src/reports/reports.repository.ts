import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { KeysetCursor } from '../common/pagination';
import type { CursorReportRow, ReportRow, ReportStatus, ReportStatusFilter } from './reports.models';

export type { ReportRow } from './reports.models';

@Injectable()
export class ReportsRepository {
  constructor(private readonly database: DatabaseService) {}

  async accountExists(userId: string): Promise<boolean> {
    return !!(await this.database.query<{ user_id: string }>(`
      SELECT user_id FROM user_account WHERE user_id = $1 AND deleted_at IS NULL
    `, [userId])).rows[0];
  }

  async findMatchParticipants(matchId: string): Promise<{ user1_id: string; user2_id: string } | undefined> {
    return (await this.database.query<{ user1_id: string; user2_id: string }>(`
      SELECT user1_id, user2_id FROM match_init WHERE id = $1
    `, [matchId])).rows[0];
  }

  async create(report: ReportRow): Promise<void> {
    await this.database.query(`
      INSERT INTO user_report (id, reporter_id, reported_id, match_id, reason, description, status, created_at, resolved_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [report.id, report.reporter_id, report.reported_id, report.match_id, report.reason, report.description, report.status, report.created_at, report.resolved_at]);
  }

  async list(status: ReportStatusFilter, limit: number, offset: number, cursor?: KeysetCursor): Promise<CursorReportRow[]> {
    return (await this.database.query<CursorReportRow>(`
      SELECT id, reporter_id, reported_id, match_id, reason, description, status, created_at, resolved_at,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM user_report WHERE ($1 = '' OR status = $1)
        AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
      ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3
    `, [status, limit, offset, cursor?.at ?? null, cursor?.id ?? null])).rows;
  }

  async updateStatus(id: string, status: ReportStatus, adminId: string, adminRole: string): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const updated = await client.query<{ reported_id: string }>(`
        UPDATE user_report
        SET status = $2, resolved_at = CASE WHEN $2 = 'pending' THEN NULL ELSE COALESCE(resolved_at, now()) END
        WHERE id = $1
        RETURNING reported_id
      `, [id, status]);
      const report = updated.rows[0];
      if (!report) return false;
      await client.query(`
        INSERT INTO data_access_log (accessed_user_id, accessor_id, accessor_role, action, reason)
        VALUES ($1, $2, $3, 'admin_review_report', $4)
      `, [report.reported_id, adminId, adminRole, `Report ${id} moved to ${status}`]);
      return true;
    });
  }
}
