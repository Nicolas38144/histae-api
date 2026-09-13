import { Injectable } from '@nestjs/common';
import { ApiError } from '../common/api-error';
import { DatabaseService } from '../database/database.service';
import { AccountActivityService, type AssertActivity } from '../database/account-activity.service';
import type { DiscoveryAction, SwipeDecision } from './discovery.models';

const SWIPE_RETENTION_DAYS = 365;

type StoredSwipe = DiscoveryAction & { expires_at: Date };

@Injectable()
export class DiscoveryStore {
  constructor(private readonly database: DatabaseService, private readonly activity: AccountActivityService) {}

  async recordSwipe(
    actorId: string,
    targetId: string,
    decision: SwipeDecision,
  ): Promise<{ created: boolean; decision: SwipeDecision }> {
    return this.activity.run(
      [actorId, targetId],
      (assertHeld) => this.recordWhileActive(actorId, targetId, decision, assertHeld),
    );
  }

  private async recordWhileActive(
    actorId: string,
    targetId: string,
    decision: SwipeDecision,
    assertHeld: AssertActivity,
  ): Promise<{ created: boolean; decision: SwipeDecision }> {
    assertHeld();
    try {
      const result = await this.database.transaction(async (client) => {
        const now = new Date();
        const inserted = await client.query<{ decision: SwipeDecision }>(`
          INSERT INTO swipe_decision (actor_id, target_id, decision, swiped_at, expires_at)
          VALUES ($1, $2, $3, $4, $4::timestamptz + ($5 * INTERVAL '1 day'))
          ON CONFLICT (actor_id, target_id) DO NOTHING
          RETURNING decision
        `, [actorId, targetId, decision, now, SWIPE_RETENTION_DAYS]);
        if (inserted.rows[0]) return { created: true, decision: inserted.rows[0].decision };

        const existing = (await client.query<StoredSwipe>(`
          SELECT actor_id, target_id, decision, swiped_at, expires_at
          FROM swipe_decision
          WHERE actor_id = $1 AND target_id = $2
          FOR UPDATE
        `, [actorId, targetId])).rows[0];
        if (!existing) throw new Error('conflicting swipe disappeared while it was being locked');
        if (existing.expires_at.getTime() > now.getTime()) {
          return { created: false, decision: existing.decision };
        }

        const replaced = (await client.query<{ decision: SwipeDecision }>(`
          UPDATE swipe_decision
          SET decision = $3, swiped_at = $4,
            expires_at = $4::timestamptz + ($5 * INTERVAL '1 day')
          WHERE actor_id = $1 AND target_id = $2
          RETURNING decision
        `, [actorId, targetId, decision, now, SWIPE_RETENTION_DAYS])).rows[0];
        if (!replaced) throw new Error('expired swipe disappeared while it was being replaced');
        return { created: true, decision: replaced.decision };
      });
      assertHeld();
      return result;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof DiscoveryPersistenceError) throw error;
      throw new DiscoveryPersistenceError('PostgreSQL swipe write failed', { cause: error });
    }
  }

  async findSwipe(actorId: string, targetId: string): Promise<DiscoveryAction | undefined> {
    try {
      return (await this.database.query<DiscoveryAction>(`
        SELECT actor_id, target_id, decision, swiped_at
        FROM swipe_decision
        WHERE actor_id = $1 AND target_id = $2 AND expires_at > clock_timestamp()
      `, [actorId, targetId])).rows[0];
    } catch (error) {
      throw new DiscoveryPersistenceError('PostgreSQL swipe lookup failed', { cause: error });
    }
  }

  async swipedTargetIds(actorId: string, targetIds: string[]): Promise<Set<string>> {
    if (!targetIds.length) return new Set();
    try {
      const result = await this.database.query<{ target_id: string }>(`
        SELECT target_id
        FROM swipe_decision
        WHERE actor_id = $1 AND target_id = ANY($2::uuid[]) AND expires_at > clock_timestamp()
      `, [actorId, targetIds]);
      return new Set(result.rows.map((row) => row.target_id));
    } catch (error) {
      throw new DiscoveryPersistenceError('PostgreSQL swipe exclusion lookup failed', { cause: error });
    }
  }
}

export class DiscoveryPersistenceError extends Error {}
