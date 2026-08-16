import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { apiError } from '../common/api-error';
import type { CursorPage } from '../common/pagination';
import { cursorPage, decodeCursor } from '../common/pagination';
import type { PublicReport} from './reports.mapper';
import { toPublicReport } from './reports.mapper';
import type { ReportReason, ReportStatus, ReportStatusFilter } from './reports.models';
import { REPORT_REASONS, REPORT_STATUSES } from './reports.models';
import type { ReportRow } from './reports.repository';
import { ReportsRepository } from './reports.repository';

export type CreateReportInput = { reported_user_id: string; match_id: string | null; reason: ReportReason; description: string | null };

@Injectable()
export class ReportsService {
  constructor(private readonly reports: ReportsRepository) {}

  async create(reporterId: string, input: CreateReportInput): Promise<PublicReport> {
    if (!input.reported_user_id || reporterId === input.reported_user_id) {
      throw apiError(400, 'invalid_report_request', 'The report request is invalid.');
    }
    if (!REPORT_REASONS.includes(input.reason) || Buffer.byteLength(input.description ?? '') > 2_000) {
      throw apiError(400, 'invalid_report_request', 'The report request is invalid.');
    }
    if (!await this.reports.accountExists(input.reported_user_id)) {
      throw apiError(404, 'account_not_found', 'The account could not be found or has been deleted.');
    }
    if (input.match_id) {
      const row = await this.reports.findMatchParticipants(input.match_id);
      if (!row || !participants(row, reporterId, input.reported_user_id)) throw apiError(404, 'match_not_found', 'The match could not be found.');
    }
    const report: ReportRow = {
      id: randomUUID(), reporter_id: reporterId, reported_id: input.reported_user_id, match_id: input.match_id,
      reason: input.reason, description: trimOrNull(input.description), status: 'pending', created_at: new Date(), resolved_at: null,
    };
    try {
      await this.reports.create(report);
    } catch (error) {
      if (isUnique(error)) throw apiError(409, 'report_already_pending', 'A pending report already exists for this user.', error);
      throw error;
    }
    return toPublicReport(report);
  }

  async list(status: ReportStatusFilter, limit: number, offset: number, rawCursor?: string): Promise<CursorPage<PublicReport>> {
    if ((status !== '' && !REPORT_STATUSES.includes(status)) || limit < 1 || limit > 100 || offset < 0 || (rawCursor && offset !== 0)) {
      throw apiError(400, 'invalid_report_request', 'The report request is invalid.');
    }
    const rows = await this.reports.list(status, limit + 1, offset, decodeCursor(rawCursor));
    const page = cursorPage(rows, limit, (row) => row.created_at);
    return { items: page.items.map(toPublicReport), next_cursor: page.next_cursor };
  }

  async updateStatus(id: string, status: ReportStatus, adminId: string, adminRole: string): Promise<void> {
    if (!REPORT_STATUSES.includes(status)) throw apiError(400, 'invalid_report_request', 'The report request is invalid.');
    if (!await this.reports.updateStatus(id, status, adminId, adminRole)) throw apiError(404, 'report_not_found', 'The report could not be found.');
  }
}

function participants(row: { user1_id: string; user2_id: string }, first: string, second: string): boolean {
  return (row.user1_id === first || row.user2_id === first) && (row.user1_id === second || row.user2_id === second);
}

function trimOrNull(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed || null;
}

function isUnique(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
