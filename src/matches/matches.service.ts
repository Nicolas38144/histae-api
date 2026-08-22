import { Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ApiError } from '../common/api-error';
import { apiError } from '../common/api-error';
import type { CursorPage } from '../common/pagination';
import { cursorPage, decodeCursor } from '../common/pagination';
import { normalizeIdempotencyKey } from '../common/idempotency';
import type { PublicMatch, PublicMessage, PublicUserMatch } from './matches.mapper';
import { toPublicMatch, toPublicMessage, toPublicUserMatch } from './matches.mapper';
import type { MatchAvailabilityFailure, MatchRow } from './matches.models';
import { MatchesRepository } from './matches.repository';
import { MobileDeliveryService } from '../mobile/mobile-delivery.service';

const HOUR = 60 * 60 * 1_000;
const MATCH_WINDOW_MS = 24 * HOUR;

export type ContinuationQuota = { plan: string; used: number; weekly_limit?: number; remaining?: number };

@Injectable()
export class MatchesService {
  constructor(
    private readonly matches: MatchesRepository,
    @Optional() private readonly delivery?: MobileDeliveryService,
  ) {}

  async createFromMutualLike(firstUserId: string, secondUserId: string): Promise<PublicMatch> {
    if (!firstUserId || !secondUserId || firstUserId === secondUserId) {
      throw apiError(400, 'invalid_match_request', 'The match request is invalid.');
    }
    const [user1, user2] = firstUserId < secondUserId ? [firstUserId, secondUserId] : [secondUserId, firstUserId];
    const now = new Date();
    const match: MatchRow = {
      id: randomUUID(), user1_id: user1, user2_id: user2, status: 'active', expires_at: new Date(now.getTime() + MATCH_WINDOW_MS),
      purge_after: null, continuation_initiator_id: null, created_at: now, last_message_at: null,
    };
    try {
      await this.matches.create(match);
    } catch (error) {
      if (isUnique(error)) {
        const existing = await this.matches.findByPair(user1, user2);
        if (existing) return toPublicMatch(existing);
        throw error;
      }
      if (error instanceof Error && 'reason' in error && error.reason === 'blocked') {
        throw apiError(409, 'match_blocked', 'A match cannot be created between blocked users.', error);
      }
      if (error instanceof Error && 'reason' in error && error.reason === 'not_found') {
        throw apiError(404, 'discovery_candidate_not_found', 'The discovery candidate is no longer available.', error);
      }
      throw error;
    }
    const created = toPublicMatch(match);
    await this.delivery?.matchCreated(created);
    return created;
  }

  async list(userId: string, limit: number, offset: number, rawCursor?: string): Promise<CursorPage<PublicUserMatch>> {
    validateMatchPagination(userId, limit, offset, rawCursor);
    const cursor = decodeCursor(rawCursor);
    const rows = await this.matches.listDetailedForUser(userId, limit + 1, offset, cursor);
    const page = cursorPage(rows, limit, (row) => row.cursor_at);
    return { items: page.items.map(toPublicUserMatch), next_cursor: page.next_cursor };
  }

  async listForAdmin(
    targetUserId: string,
    adminId: string,
    adminRole: string,
    reason: string,
    limit: number,
    offset: number,
    rawCursor?: string,
  ): Promise<CursorPage<PublicMatch>> {
    const normalizedReason = reason.trim();
    if (normalizedReason.length < 3 || normalizedReason.length > 500) {
      throw apiError(400, 'invalid_match_request', 'The match request is invalid.');
    }
    validateMatchPagination(targetUserId, limit, offset, rawCursor);
    const cursor = decodeCursor(rawCursor);
    const rows = await this.matches.listForUser(targetUserId, limit + 1, offset, cursor);
    const rawPage = cursorPage(rows, limit, (row) => row.cursor_at);
    const page: CursorPage<PublicMatch> = {
      items: rawPage.items.map(toPublicMatch),
      next_cursor: rawPage.next_cursor,
    };
    if (!await this.matches.logAdminMatchAccess(targetUserId, adminId, adminRole, normalizedReason)) {
      throw apiError(404, 'account_not_found', 'The account could not be found or has been deleted.');
    }
    return page;
  }

  async reveal(matchId: string, userId: string): Promise<boolean> {
    const result = await this.matches.recordReveal(matchId, userId);
    if (!result.ok) throwMatchCommandError(result.reason, 'match');
    const participants = await this.matches.participantIds(matchId, userId);
    if (participants) await this.delivery?.matchUpdated(matchId, participants, { photos_revealed: result.value });
    return result.value;
  }

  async continue(matchId: string, userId: string): Promise<boolean> {
    const result = await this.matches.recordContinuationConsent(matchId, userId);
    if (result === 'confirmed' || result === 'pending' || result === 'already_recorded') {
      const confirmed = result === 'confirmed';
      const participants = await this.matches.participantIds(matchId, userId);
      if (participants) await this.delivery?.matchUpdated(matchId, participants, { match_confirmed: confirmed });
      return confirmed;
    }
    if (result === 'not_available_yet') {
      throw apiError(409, 'continuation_not_available_yet', 'Continuation becomes available after the initial 24-hour match period.');
    }
    if (result === 'quota_reached') {
      throw apiError(403, 'continuation_quota_reached', 'The weekly continuation quota has been reached. Upgrade to Premium for unlimited continuations.');
    }
    if (result === 'expired') throw apiError(410, 'match_expired', 'This match has expired.');
    if (result === 'not_found') throw notFoundMatch();
    throw apiError(409, 'invalid_match_state', "This action is not available in the match's current state.");
  }

  async getContinuationAllowance(userId: string): Promise<ContinuationQuota> {
    const plan = await this.matches.effectivePlan(userId, new Date());
    if (plan.weeklyLimit === null) return { plan: plan.plan, used: 0 };
    const used = await this.matches.continuationUsage(userId, weekStart(new Date()));
    return { plan: plan.plan, weekly_limit: plan.weeklyLimit, used, remaining: Math.max(plan.weeklyLimit - used, 0) };
  }

  async getMessages(matchId: string, userId: string, limit: number, offset: number, rawCursor?: string): Promise<CursorPage<PublicMessage>> {
    if (limit < 1 || limit > 100 || offset < 0 || (rawCursor && offset !== 0)) {
      throw apiError(400, 'invalid_message_request', 'The message request is invalid.');
    }
    const cursor = decodeCursor(rawCursor);
    const result = await this.matches.messagesForUser(matchId, userId, limit + 1, offset, cursor);
    if (!result.ok) throwMatchCommandError(result.reason, 'message');
    const page = cursorPage(result.value, limit, (row) => row.cursor_at);
    return { items: page.items.map(toPublicMessage), next_cursor: page.next_cursor };
  }

  async sendMessage(
    matchId: string,
    senderId: string,
    rawContent: string,
    idempotencyInput: string | undefined,
  ): Promise<PublicMessage> {
    const content = rawContent.trim();
    if (!content || [...content].length > 2_000) throw apiError(400, 'invalid_message_request', 'The message request is invalid.');
    const idempotencyKey = normalizeIdempotencyKey(idempotencyInput);
    const result = await this.matches.createMessage(randomUUID(), matchId, senderId, content, idempotencyKey);
    if (!result.ok && result.reason === 'idempotency_conflict') {
      throw apiError(409, 'idempotency_key_conflict', 'The idempotency key was already used for another request.');
    }
    if (!result.ok) throwMatchCommandError(result.reason, 'message');
    const message = toPublicMessage(result.value.message);
    if (result.value.created) await this.delivery?.messageCreated(message, result.value.participant_ids);
    return message;
  }

  async markAsRead(matchId: string, messageId: string, userId: string): Promise<void> {
    const result = await this.matches.markMessageRead(matchId, messageId, userId);
    if (!result.ok) throwMatchCommandError(result.reason, 'message');
    if (!result.value) {
      throw apiError(404, 'message_not_found', 'The message could not be found.');
    }
    await this.delivery?.messagesRead(matchId, result.value.participant_ids, userId, result.value.read_through_message_id);
  }

  async markReadThrough(matchId: string, messageId: string, userId: string): Promise<number> {
    const result = await this.matches.markMessagesReadThrough(matchId, messageId, userId);
    if (!result.ok) throwMatchCommandError(result.reason, 'message');
    if (!result.value) throw apiError(404, 'message_not_found', 'The message could not be found.');
    if (result.value.updated_count > 0) {
      await this.delivery?.messagesRead(matchId, result.value.participant_ids, userId, result.value.read_through_message_id);
    }
    return result.value.updated_count;
  }
}

function validateMatchPagination(userId: string, limit: number, offset: number, rawCursor?: string): void {
  if (!userId || limit < 1 || limit > 100 || offset < 0 || (rawCursor && offset !== 0)) {
    throw apiError(400, 'invalid_match_request', 'The match request is invalid.');
  }
}

function notFoundMatch(): ApiError {
  return apiError(404, 'match_not_found', 'The match could not be found.');
}

function weekStart(now: Date): Date {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date;
}

function isUnique(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function throwMatchCommandError(reason: MatchAvailabilityFailure, caller: 'match' | 'message'): never {
  if (reason === 'not_found') throw notFoundMatch();
  if (reason === 'expired') throw apiError(410, 'match_expired', 'This match has expired.');
  if (caller === 'match') throw apiError(409, 'invalid_match_state', "This action is not available in the match's current state.");
  throw apiError(409, 'messaging_not_available', 'Messaging is not available for this match.');
}
