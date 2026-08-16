export const REPORT_REASONS = ['inappropriate_content', 'fake_profile', 'harassment', 'spam', 'other'] as const;
export type ReportReason = typeof REPORT_REASONS[number];

export const REPORT_STATUSES = ['pending', 'reviewed', 'dismissed'] as const;
export type ReportStatus = typeof REPORT_STATUSES[number];

export type ReportStatusFilter = ReportStatus | '';

export type ReportRow = {
  id: string;
  reporter_id: string;
  reported_id: string;
  match_id: string | null;
  reason: ReportReason;
  description: string | null;
  status: ReportStatus;
  created_at: Date;
  resolved_at: Date | null;
};

export type CursorReportRow = ReportRow & { cursor_at: string };
