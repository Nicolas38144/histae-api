import { Injectable } from '@nestjs/common';
import { apiError } from '../common/api-error';
import type { CursorPage } from '../common/pagination';
import { cursorPage, decodeCursor } from '../common/pagination';
import { ConfigService } from '../config/config.service';
import { toPublicMessage, type PublicMessage } from '../matches/matches.mapper';
import { OUTBOX_LOCK_TIMEOUT_MILLIS } from '../outbox/outbox.constants';
import { PHOTO_PROCESSING_STALE_AFTER_MILLIS } from '../photos/photos.constants';
import type {
  AdminMetrics,
  AdminPhotoReconciliation,
  AdminRevenue,
  AdminUser,
  AdminUserDetail,
  AdminUserRow,
  AdminUserStatus,
  PhotoReconciliationFilter,
  RevenuePeriod,
} from './admin.models';
import { AdminRepository } from './admin.repository';
import { PhotosService } from '../photos/photos.service';

type AdminRole = 'admin' | 'superadmin';

@Injectable()
export class AdminService {
  constructor(
    private readonly admin: AdminRepository,
    private readonly config: ConfigService,
    private readonly photos: PhotosService,
  ) {}

  async listUsers(
    status: AdminUserStatus | undefined,
    role: 'user' | 'admin' | 'superadmin' | undefined,
    rawSearch: string | undefined,
    limit: number,
    offset: number,
    rawCursor?: string,
  ): Promise<CursorPage<AdminUser>> {
    if (limit < 1 || limit > 100 || offset < 0 || (rawCursor && offset !== 0)) throw invalidAdminRequest();
    const search = rawSearch?.trim() ?? '';
    const rows = await this.admin.listUsers(
      status, role, search, limit + 1, offset, decodeCursor(rawCursor),
      this.config.legal.termsVersion, this.config.legal.privacyVersion,
    );
    const page = cursorPage(rows, limit, (row) => row.cursor_at);
    return {
      items: page.items.map((row) => toAdminUser(row, null)),
      next_cursor: page.next_cursor,
    };
  }

  async userDetail(targetId: string, adminId: string, adminRole: AdminRole, rawReason: string): Promise<AdminUserDetail> {
    const reason = normalizeReason(rawReason);
    const user = await this.admin.userDetail(
      targetId, adminId, adminRole, reason, this.config.legal.termsVersion, this.config.legal.privacyVersion,
    );
    if (!user) throw apiError(404, 'account_not_found', 'The account could not be found or has been deleted.');
    return { ...user, photo: await this.photos.urlForKey(user.photo) };
  }

  async updateBanStatus(
    targetId: string,
    isBanned: boolean,
    rawReason: string | null | undefined,
    adminId: string,
    adminRole: AdminRole,
  ): Promise<void> {
    const reason = isBanned ? normalizeReason(rawReason ?? '') : normalizeReason(rawReason || 'Administrative unban');
    const result = await this.admin.setUserBan(targetId, isBanned, reason, adminId, adminRole);
    if (result === 'not_found') throw apiError(404, 'account_not_found', 'The account could not be found or has been deleted.');
    if (result === 'forbidden') throw apiError(403, 'admin_action_forbidden', 'The administrator cannot change this account.');
  }

  metrics(revenuePeriod: RevenuePeriod): Promise<AdminMetrics> {
    return this.admin.metrics(
      this.config.legal.termsVersion,
      this.config.legal.privacyVersion,
      revenuePeriod,
      stalePhotoCutoff(),
    );
  }

  revenue(revenuePeriod: RevenuePeriod): Promise<AdminRevenue> {
    return this.admin.revenue(revenuePeriod);
  }

  async photoReconciliation(
    status: PhotoReconciliationFilter,
    limit: number,
    offset: number,
    rawCursor?: string,
  ): Promise<CursorPage<AdminPhotoReconciliation>> {
    if (limit < 1 || limit > 100 || offset < 0 || (rawCursor && offset !== 0)) {
      throw invalidAdminRequest();
    }
    const rows = await this.admin.listPhotoReconciliation(
      status,
      stalePhotoCutoff(),
      limit + 1,
      offset,
      decodeCursor(rawCursor),
    );
    const page = cursorPage(rows, limit, (row) => row.cursor_at);
    return {
      items: page.items.map(toAdminPhotoReconciliation),
      next_cursor: page.next_cursor,
    };
  }

  async reconcilePhoto(
    photoId: string,
    rawReason: string,
    adminId: string,
    adminRole: AdminRole,
  ): Promise<void> {
    const now = Date.now();
    const result = await this.admin.reconcilePhoto(
      photoId,
      new Date(now - PHOTO_PROCESSING_STALE_AFTER_MILLIS),
      new Date(now - OUTBOX_LOCK_TIMEOUT_MILLIS),
      adminId,
      adminRole,
      normalizeReason(rawReason),
    );
    if (result === 'not_found') {
      throw apiError(404, 'photo_not_found', 'The profile photo could not be found.');
    }
    if (result === 'not_actionable') {
      throw apiError(409, 'photo_reconciliation_not_allowed', 'This profile photo does not require reconciliation.');
    }
    if (result === 'already_processing') {
      throw apiError(409, 'photo_reconciliation_in_progress', 'This profile photo is already being processed.');
    }
  }

  async messages(
    matchId: string,
    adminId: string,
    adminRole: AdminRole,
    rawReason: string,
    limit: number,
    offset: number,
    rawCursor?: string,
  ): Promise<CursorPage<PublicMessage>> {
    if (limit < 1 || limit > 100 || offset < 0 || (rawCursor && offset !== 0)) throw invalidAdminRequest();
    const rows = await this.admin.messages(matchId, adminId, adminRole, normalizeReason(rawReason), limit + 1, offset, decodeCursor(rawCursor));
    if (!rows) throw apiError(404, 'match_not_found', 'The match could not be found.');
    const page = cursorPage(rows, limit, (row) => row.cursor_at);
    return { items: page.items.map(toPublicMessage), next_cursor: page.next_cursor };
  }
}

function toAdminUser(row: AdminUserRow, photoUrl: string | null): AdminUser {
  return {
    user_id: row.id,
    role: row.role,
    is_banned: row.is_banned,
    banned_at: row.banned_at,
    created_at: row.created_at,
    firstname: row.firstname,
    birthdate: row.birthdate === null ? null : row.birthdate instanceof Date ? row.birthdate.toISOString().slice(0, 10) : String(row.birthdate).slice(0, 10),
    sex: row.sex,
    photo: photoUrl,
    plan: row.plan,
    onboarding_complete: row.onboarding_complete,
    reports_received: row.reports_received,
    matches_count: row.matches_count,
  };
}

function toAdminPhotoReconciliation(
  row: Awaited<ReturnType<AdminRepository['listPhotoReconciliation']>>[number],
): AdminPhotoReconciliation {
  return {
    photo_id: row.id,
    user_id: row.user_id,
    status: row.status,
    size_bytes: row.size_bytes,
    width: row.width,
    height: row.height,
    created_at: row.created_at,
    updated_at: row.updated_at,
    outbox_status: row.outbox_status,
    outbox_attempts: row.outbox_attempts,
    outbox_available_at: row.outbox_available_at,
    outbox_locked_at: row.outbox_locked_at,
    outbox_last_error_code: row.outbox_last_error_code,
    issue: row.issue,
  };
}

function normalizeReason(value: string): string {
  const reason = value.trim();
  if (reason.length < 3 || reason.length > 500) throw invalidAdminRequest();
  return reason;
}

function invalidAdminRequest(): ReturnType<typeof apiError> {
  return apiError(400, 'invalid_admin_request', 'The administrator request is invalid.');
}

function stalePhotoCutoff(now = Date.now()): Date {
  return new Date(now - PHOTO_PROCESSING_STALE_AFTER_MILLIS);
}
