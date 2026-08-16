import type { ReportRow } from './reports.repository';
import type { ReportReason, ReportStatus } from './reports.models';

export type PublicReport = {
  id: string;
  reporter_id: string;
  reported_id: string;
  match_id?: string;
  reason: ReportReason;
  description?: string;
  status: ReportStatus;
  created_at: Date;
};

export function toPublicReport(row: ReportRow): PublicReport {
  const report: PublicReport = {
    id: row.id,
    reporter_id: row.reporter_id,
    reported_id: row.reported_id,
    reason: row.reason,
    status: row.status,
    created_at: row.created_at,
  };
  if (row.match_id !== null) report.match_id = row.match_id;
  if (row.description !== null) report.description = row.description;
  return report;
}
