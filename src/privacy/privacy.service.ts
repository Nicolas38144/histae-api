import { Injectable, Optional } from '@nestjs/common';
import { apiError } from '../common/api-error';
import { cursorPage, decodeCursor, type CursorPage } from '../common/pagination';
import type { BlockedUser, DataAccessLogRow, DataRequestStatus, DataRequestType, DataSubjectRequestRow } from './privacy.models';
import { PrivacyRepository } from './privacy.repository';
import { MobileDeliveryService } from '../mobile/mobile-delivery.service';

@Injectable()
export class PrivacyService {
  constructor(
    private readonly privacy: PrivacyRepository,
    @Optional() private readonly delivery?: MobileDeliveryService,
  ) {}

  async createRequest(userId: string, type: DataRequestType): Promise<DataSubjectRequestRow> {
    const request = await this.privacy.createRequest(userId, type);
    if (!request) throw apiError(409, 'data_request_already_open', 'An open request of this type already exists.');
    return request;
  }

  requestsForUser(userId: string): Promise<DataSubjectRequestRow[]> {
    return this.privacy.requestsForUser(userId);
  }

  async requestsForAdmin(
    status: DataRequestStatus | undefined,
    limit: number,
    offset: number,
    rawCursor?: string,
  ): Promise<CursorPage<DataSubjectRequestRow>> {
    rejectMixedPagination(offset, rawCursor);
    const rows = await this.privacy.requestsForAdmin(
      status,
      limit + 1,
      offset,
      decodeCursor(rawCursor),
    );
    const page = cursorPage(rows, limit, (row) => row.cursor_at);
    return { items: page.items.map(withoutCursor), next_cursor: page.next_cursor };
  }

  async updateRequest(
    requestId: string,
    status: Exclude<DataRequestStatus, 'pending'>,
    adminId: string,
    adminRole: string,
    notes: string | null,
  ): Promise<'updated' | 'erasure_scheduled'> {
    const result = await this.privacy.updateRequest(requestId, status, adminId, adminRole, notes);
    if (result === 'not_found') throw apiError(404, 'data_request_not_found', 'The data subject request was not found.');
    if (result === 'invalid_transition') throw apiError(409, 'invalid_data_request_transition', 'This data subject request transition is not allowed.');
    return result;
  }

  async blockUser(blockerId: string, blockedId: string): Promise<void> {
    if (blockerId === blockedId) throw apiError(400, 'invalid_block_request', 'An account cannot block itself.');
    if (!await this.privacy.blockUser(blockerId, blockedId)) throw apiError(404, 'user_not_found', 'The user to block was not found.');
    await this.delivery?.matchesInvalidated([blockerId, blockedId]);
  }

  async unblockUser(blockerId: string, blockedId: string): Promise<void> {
    await this.privacy.unblockUser(blockerId, blockedId);
    await this.delivery?.matchesInvalidated([blockerId, blockedId]);
  }

  blockedUsers(blockerId: string): Promise<BlockedUser[]> {
    return this.privacy.blockedUsers(blockerId);
  }

  async accessLogs(
    accessedUserId: string,
    limit: number,
    offset: number,
    rawCursor?: string,
  ): Promise<CursorPage<DataAccessLogRow>> {
    rejectMixedPagination(offset, rawCursor);
    const rows = await this.privacy.accessLogs(
      accessedUserId,
      limit + 1,
      offset,
      decodeCursor(rawCursor),
    );
    const page = cursorPage(rows, limit, (row) => row.cursor_at);
    return { items: page.items.map(withoutCursor), next_cursor: page.next_cursor };
  }
}

function rejectMixedPagination(offset: number, cursor?: string): void {
  if (cursor && offset !== 0) {
    throw apiError(400, 'invalid_cursor', 'Cursor pagination cannot be combined with an offset.');
  }
}

function withoutCursor<T extends { cursor_at: string }>(row: T): Omit<T, 'cursor_at'> {
  const { cursor_at: _cursorAt, ...item } = row;
  void _cursorAt;
  return item;
}
