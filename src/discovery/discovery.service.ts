import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { apiError } from '../common/api-error';
import type { PublicMatch } from '../matches/matches.mapper';
import { MatchesService } from '../matches/matches.service';
import { ScyllaUnavailableError } from '../scylla/scylla.service';
import { ConfigService } from '../config/config.service';
import type { DiscoveryCandidateRow, DiscoveryCursor, FeedCandidate, SwipeDecision } from './discovery.models';
import { SWIPE_DECISIONS } from './discovery.models';
import { DiscoveryRepository } from './discovery.repository';
import { DiscoveryStore } from './discovery.store';

const MAX_FEED_BATCHES = 20;

@Injectable()
export class DiscoveryService {
  constructor(
    private readonly discovery: DiscoveryRepository,
    private readonly store: DiscoveryStore,
    private readonly matches: MatchesService,
    private readonly config: ConfigService,
  ) {}

  async feed(userId: string, limit: number, rawCursor?: string): Promise<{ profiles: FeedCandidate[]; next_cursor: string | null }> {
    this.requireAvailable();
    if (limit < 1 || limit > 100) throw apiError(400, 'invalid_feed_request', 'The feed request is invalid.');
    await this.requireReady(userId);
    let cursor = decodeDiscoveryCursor(rawCursor);
    const visible: DiscoveryCandidateRow[] = [];
    const batchSize = Math.max(50, (limit + 1) * 4);
    let databaseExhausted = false;
    try {
      for (let batch = 0; batch < MAX_FEED_BATCHES && visible.length < limit + 1; batch += 1) {
        const candidates = await this.discovery.candidateBatch(
          userId,
          this.config.legal.sensitiveDataConsentVersion,
          this.config.legal.locationConsentVersion,
          batchSize,
          cursor,
        );
        if (!candidates.length) {
          databaseExhausted = true;
          break;
        }
        const swiped = await this.store.swipedTargetIds(userId, candidates.map((candidate) => candidate.user_id));
        visible.push(...candidates.filter((candidate) => !swiped.has(candidate.user_id)));
        const last = candidates.at(-1)!;
        cursor = { distance_km: last.distance_km, id: last.user_id };
        if (candidates.length < batchSize) {
          databaseExhausted = true;
          break;
        }
      }
    } catch (error) {
      throwDiscoveryUnavailable(error);
    }
    const hasMore = visible.length > limit || !databaseExhausted;
    const page = visible.slice(0, limit);
    const profiles = page.map(toFeedCandidate);
    const last = page.at(-1);
    const nextCursor = hasMore
      ? visible.length > limit && last
        ? encodeDiscoveryCursor(last.distance_km, last.user_id)
        : cursor ? encodeDiscoveryCursor(cursor.distance_km, cursor.id) : null
      : null;
    return {
      profiles,
      next_cursor: nextCursor,
    };
  }

  async swipe(
    actorId: string,
    targetId: string,
    decision: SwipeDecision,
  ): Promise<{ decision: SwipeDecision; matched: boolean; match?: PublicMatch }> {
    this.requireAvailable();
    if (actorId === targetId || !isUUID(targetId, 'all') || !SWIPE_DECISIONS.includes(decision)) {
      throw apiError(400, 'invalid_swipe_request', 'The swipe request is invalid.');
    }
    await this.requireReady(actorId);
    if (!await this.discovery.isSwipeTargetAvailable(
      actorId,
      targetId,
      this.config.legal.sensitiveDataConsentVersion,
      this.config.legal.locationConsentVersion,
    )) throw apiError(404, 'discovery_candidate_not_found', 'The discovery candidate is not available.');

    try {
      const recorded = await this.store.recordSwipe(actorId, targetId, decision);
      if (!recorded.created && recorded.decision !== decision) {
        throw apiError(409, 'swipe_already_recorded', 'A different swipe decision was already recorded for this user.');
      }
      if (decision === 'pass') return { decision, matched: false };
      const reciprocal = await this.store.findSwipe(targetId, actorId);
      if (reciprocal?.decision !== 'like') return { decision, matched: false };
      const match = await this.matches.createFromMutualLike(actorId, targetId);
      return { decision, matched: true, match };
    } catch (error) {
      if (error instanceof ScyllaUnavailableError) throwDiscoveryUnavailable(error);
      throw error;
    }
  }

  private async requireReady(userId: string): Promise<void> {
    const ready = await this.discovery.isDiscoveryReady(
      userId,
      this.config.legal.sensitiveDataConsentVersion,
      this.config.legal.locationConsentVersion,
    );
    if (!ready) {
      throw apiError(409, 'discovery_not_ready', 'A complete profile, preferences, current consents and a fresh location are required for discovery.');
    }
  }

  private requireAvailable(): void {
    if (!this.store.available) throw apiError(503, 'discovery_unavailable', 'Discovery is temporarily unavailable.');
  }
}

function toFeedCandidate(row: DiscoveryCandidateRow): FeedCandidate {
  return { ...row, distance_km: Number(row.distance_km.toFixed(1)) };
}

function encodeDiscoveryCursor(distanceKm: number, id: string): string {
  return Buffer.from(JSON.stringify({ distance_km: distanceKm, id }), 'utf8').toString('base64url');
}

function decodeDiscoveryCursor(value?: string): DiscoveryCursor | undefined {
  if (!value) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null || !('distance_km' in decoded) || !('id' in decoded)
      || typeof decoded.distance_km !== 'number' || !Number.isFinite(decoded.distance_km) || decoded.distance_km < 0
      || typeof decoded.id !== 'string' || !isUUID(decoded.id, 'all')) throw new Error('invalid discovery cursor');
    return { distance_km: decoded.distance_km, id: decoded.id };
  } catch (error) {
    throw apiError(400, 'invalid_cursor', 'The pagination cursor is invalid.', error);
  }
}

function throwDiscoveryUnavailable(error: unknown): never {
  if (error instanceof ScyllaUnavailableError) {
    throw apiError(503, 'discovery_unavailable', 'Discovery is temporarily unavailable.', error);
  }
  throw error;
}
