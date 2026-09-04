import { Injectable } from '@nestjs/common';
import type { types } from 'cassandra-driver';
import { ScyllaService, ScyllaUnavailableError } from '../scylla/scylla.service';
import { AccountActivityService, type AssertActivity } from '../database/account-activity.service';
import type { DiscoveryAction, SwipeDecision } from './discovery.models';
import { SWIPE_DECISIONS } from './discovery.models';

const BUCKET_COUNT = 32;
const MAX_PARALLEL_QUERIES = 20;

@Injectable()
export class DiscoveryStore {
  constructor(private readonly scylla: ScyllaService, private readonly activity: AccountActivityService) {}

  get available(): boolean {
    return this.scylla.enabled;
  }

  async recordSwipe(actorId: string, targetId: string, decision: SwipeDecision): Promise<{ created: boolean; decision: SwipeDecision }> {
    return this.activity.run([actorId, targetId], (assertHeld) => this.recordWhileActive(actorId, targetId, decision, assertHeld));
  }

  private async recordWhileActive(actorId: string, targetId: string, decision: SwipeDecision, assertHeld: AssertActivity) {
    assertHeld();
    const now = new Date();
    const result = await this.scylla.execute(`
      INSERT INTO swipes_by_actor_bucket (actor_id, bucket, target_id, decision, swiped_at)
      VALUES (?, ?, ?, ?, ?) IF NOT EXISTS
    `, [actorId, uuidBucket(targetId), targetId, decision, now], { isIdempotent: true });

    let storedDecision = decision;
    let storedAt = now;
    let remainingTtl: number | undefined;
    if (!result.wasApplied()) {
      const existing = await this.scylla.execute(`
        SELECT decision, swiped_at, TTL(decision) AS remaining_ttl
        FROM swipes_by_actor_bucket
        WHERE actor_id = ? AND bucket = ? AND target_id = ?
      `, [actorId, uuidBucket(targetId), targetId], { isIdempotent: true });
      const row = existing.first();
      if (!row) throw new Error('existing swipe expired before its mirror could be repaired');
      storedDecision = parseDecision(row.get('decision'));
      storedAt = asDate(row.get('swiped_at'));
      remainingTtl = positiveTtl(row.get('remaining_ttl'));
    }
    assertHeld();
    await this.writeTargetMirror(actorId, targetId, storedDecision, storedAt, remainingTtl);
    return { created: result.wasApplied(), decision: storedDecision };
  }

  async findSwipe(actorId: string, targetId: string): Promise<DiscoveryAction | undefined> {
    const result = await this.scylla.execute(`
      SELECT actor_id, target_id, decision, swiped_at
      FROM swipes_by_actor_bucket
      WHERE actor_id = ? AND bucket = ? AND target_id = ?
    `, [actorId, uuidBucket(targetId), targetId], { isIdempotent: true });
    return result.first() ? actorRow(result.first()) : undefined;
  }

  async swipedTargetIds(actorId: string, targetIds: string[]): Promise<Set<string>> {
    const byBucket = new Map<number, string[]>();
    for (const targetId of targetIds) {
      const bucket = uuidBucket(targetId);
      byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), targetId]);
    }
    const queries = [...byBucket.entries()].map(async ([bucket, ids]) => {
      const placeholders = ids.map(() => '?').join(', ');
      const result = await this.scylla.execute(`
        SELECT target_id FROM swipes_by_actor_bucket
        WHERE actor_id = ? AND bucket = ? AND target_id IN (${placeholders})
      `, [actorId, bucket, ...ids], { isIdempotent: true });
      return result.rows.map((row) => String(row.get('target_id')));
    });
    return new Set((await Promise.all(queries)).flat());
  }

  async exportOwnActions(userId: string): Promise<DiscoveryAction[]> {
    if (!this.available) return [];
    const outgoingRows = await Promise.all(Array.from({ length: BUCKET_COUNT }, (_, bucket) => this.scylla.execute(`
      SELECT actor_id, target_id, decision, swiped_at
      FROM swipes_by_actor_bucket WHERE actor_id = ? AND bucket = ?
    `, [userId, bucket], { isIdempotent: true })));
    return outgoingRows.flatMap((result) => result.rows.map(actorRow));
  }

  async deleteUserData(userId: string): Promise<void> {
    for (let partition = 0; partition < BUCKET_COUNT * 2;) {
      if (await this.deleteUserDataBatch(userId, partition)) partition++;
    }
  }

  /** The erasure worker holds the exclusive account activity lock. */
  async deleteUserDataBatch(userId: string, partition: number): Promise<boolean> {
    if (!this.available) throw new ScyllaUnavailableError('ScyllaDB is disabled');
    if (!Number.isInteger(partition) || partition < 0 || partition >= BUCKET_COUNT * 2) throw new Error('invalid_erasure_partition');
    const outgoing = partition < BUCKET_COUNT;
    const table = outgoing ? 'swipes_by_actor_bucket' : 'swipes_by_target_bucket';
    const ownerColumn = outgoing ? 'actor_id' : 'target_id';
    const peerColumn = outgoing ? 'target_id' : 'actor_id';
    const mirrorTable = outgoing ? 'swipes_by_target_bucket' : 'swipes_by_actor_bucket';
    const bucket = partition % BUCKET_COUNT;
    const batchSize = 100;
    const data = await this.scylla.execute(`SELECT ${peerColumn} FROM ${table}
      WHERE ${ownerColumn} = ? AND bucket = ? LIMIT ${batchSize}`,
    [userId, bucket], { isIdempotent: true, fetchSize: batchSize });
    await runLimited(data.rows.map((row) => async () => {
      const peer = String(row.get(peerColumn));
      // Keep the source reference until its counterpart is confirmed deleted.
      await this.scylla.execute(`DELETE FROM ${mirrorTable}
        WHERE ${peerColumn} = ? AND bucket = ? AND ${ownerColumn} = ?`,
      [peer, uuidBucket(userId), userId], { isIdempotent: true });
      await this.scylla.execute(`DELETE FROM ${table}
        WHERE ${ownerColumn} = ? AND bucket = ? AND ${peerColumn} = ?`,
      [userId, bucket, peer], { isIdempotent: true });
    }));
    return data.rows.length < batchSize;
  }

  private async writeTargetMirror(
    actorId: string,
    targetId: string,
    decision: SwipeDecision,
    swipedAt: Date,
    ttl?: number,
  ): Promise<void> {
    if (ttl === undefined) {
      await this.scylla.execute(`
        INSERT INTO swipes_by_target_bucket (target_id, bucket, actor_id, decision, swiped_at)
        VALUES (?, ?, ?, ?, ?)
      `, [targetId, uuidBucket(actorId), actorId, decision, swipedAt], { isIdempotent: true });
      return;
    }
    await this.scylla.execute(`
      INSERT INTO swipes_by_target_bucket (target_id, bucket, actor_id, decision, swiped_at)
      VALUES (?, ?, ?, ?, ?) USING TTL ?
    `, [targetId, uuidBucket(actorId), actorId, decision, swipedAt, ttl], { isIdempotent: true });
  }
}

export function uuidBucket(value: string): number {
  const compact = value.replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/i.test(compact)) throw new Error('invalid UUID for discovery bucket');
  return Number.parseInt(compact.slice(0, 2), 16) % BUCKET_COUNT;
}

function parseDecision(value: unknown): SwipeDecision {
  if (typeof value === 'string' && SWIPE_DECISIONS.includes(value as SwipeDecision)) return value as SwipeDecision;
  throw new Error('invalid swipe decision stored in ScyllaDB');
}

function asDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error('invalid swipe timestamp stored in ScyllaDB');
  return date;
}

function positiveTtl(value: unknown): number {
  const ttl = Number(value);
  if (!Number.isSafeInteger(ttl) || ttl < 1) throw new Error('invalid swipe TTL stored in ScyllaDB');
  return ttl;
}

function actorRow(row: types.Row): DiscoveryAction {
  return {
    actor_id: String(row.get('actor_id')),
    target_id: String(row.get('target_id')),
    decision: parseDecision(row.get('decision')),
    swiped_at: asDate(row.get('swiped_at')),
  };
}

async function runLimited(tasks: Array<() => Promise<unknown>>): Promise<void> {
  for (let index = 0; index < tasks.length; index += MAX_PARALLEL_QUERIES) {
    const outcomes = await Promise.allSettled(tasks.slice(index, index + MAX_PARALLEL_QUERIES).map((task) => task()));
    const failed = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failed) throw failed.reason;
  }
}
