import { Injectable } from '@nestjs/common';
import { apiError } from '../common/api-error';
import type { CursorPage } from '../common/pagination';
import { cursorPage, decodeCursor } from '../common/pagination';
import { PhotosService } from '../photos/photos.service';
import type {
  ModerationCase,
  ModerationCaseRow,
  ModerationContentType,
  ModerationDetail,
  ModerationDecision,
  ModerationReviewInput,
  ModerationStatus,
  PhotoReviewChecks,
} from './moderation.models';
import { ModerationRepository } from './moderation.repository';

type AdminRole = 'admin' | 'superadmin';

@Injectable()
export class ModerationService {
  constructor(
    private readonly moderation: ModerationRepository,
    private readonly photos: PhotosService,
  ) {}

  async list(
    status: ModerationStatus | undefined,
    contentType: ModerationContentType | undefined,
    limit: number,
    offset: number,
    rawCursor?: string,
  ): Promise<CursorPage<ModerationCase>> {
    if (limit < 1 || limit > 100 || offset < 0 || (rawCursor && offset !== 0)) throw invalidRequest();
    const rows = await this.moderation.list(status, contentType, limit + 1, offset, decodeCursor(rawCursor));
    const page = cursorPage(rows, limit, (row) => row.cursor_at);
    return { items: page.items.map(toCase), next_cursor: page.next_cursor };
  }

  async detail(
    caseId: string,
    adminId: string,
    adminRole: AdminRole,
    rawReason: string,
  ): Promise<ModerationDetail> {
    const row = await this.moderation.detail(caseId, adminId, adminRole, normalizeReason(rawReason));
    if (!row) throw apiError(404, 'moderation_case_not_found', 'The moderation case could not be found.');
    const result: ModerationDetail = {
      ...toCase(row),
      content: row.text_content,
      question: row.question,
      photo: row.object_key ? await this.photos.urlForKey(row.object_key) : null,
    };
    return result;
  }

  async review(
    caseId: string,
    version: number,
    decision: ModerationDecision,
    rawReason: string,
    photoChecks: PhotoReviewChecks | undefined,
    adminId: string,
    adminRole: AdminRole,
  ): Promise<void> {
    validatePhotoChecks(decision, photoChecks);
    const input: ModerationReviewInput = {
      version,
      decision,
      reason: normalizeReason(rawReason),
      ...(photoChecks ? { photoChecks } : {}),
    };
    const result = await this.moderation.review(caseId, input, adminId, adminRole);
    if (result === 'not_found') throw apiError(404, 'moderation_case_not_found', 'The moderation case could not be found.');
    if (result === 'stale') throw apiError(409, 'moderation_case_stale', 'The moderation case has changed; refresh it before reviewing.');
    if (result === 'not_actionable') throw apiError(409, 'moderation_review_not_allowed', 'This moderation decision is not valid for the current content.');
  }
}

function toCase(row: ModerationCaseRow): ModerationCase {
  const { id, cursor_at: _cursorAt, ...rest } = row;
  void _cursorAt;
  return { case_id: id, ...rest };
}

function validatePhotoChecks(decision: ModerationDecision, checks: PhotoReviewChecks | undefined): void {
  if (!checks) return;
  const values = [checks.face_detectable, checks.sharp_enough, checks.content_allowed];
  if ((decision === 'approved' && values.some((value) => !value))
    || (decision === 'rejected' && values.every(Boolean))) throw invalidRequest();
}

function normalizeReason(value: string): string {
  const reason = value.normalize('NFKC').trim();
  if (reason.length < 3 || reason.length > 500 || Buffer.byteLength(reason) > 1_000) throw invalidRequest();
  return reason;
}

function invalidRequest(): ReturnType<typeof apiError> {
  return apiError(400, 'invalid_moderation_request', 'The moderation request is invalid.');
}
