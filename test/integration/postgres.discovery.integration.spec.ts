import { open, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { DiscoveryRepository } from '../../src/discovery/discovery.repository';
import { DiscoveryService } from '../../src/discovery/discovery.service';
import { DiscoveryStore } from '../../src/discovery/discovery.store';
import { MatchesRepository } from '../../src/matches/matches.repository';
import { MatchMessageRepository } from '../../src/matches/match-message.repository';
import { MatchesService } from '../../src/matches/matches.service';
import { DataExportRepository } from '../../src/privacy/data-export.repository';
import { JsonExportWriter } from '../../src/privacy/json-export.writer';
import { accountActivityStub } from '../account-activity.stub';
import { IsolatedPostgres } from '../helpers/isolated-postgres';

const LEGAL_VERSION = 'postgres-discovery-v1';
const photos = { urlForKey: async (): Promise<null> => null };

describe('PostgreSQL discovery persistence', () => {
  const fixture = new IsolatedPostgres();
  let store: DiscoveryStore;
  let discovery: DiscoveryService;

  beforeAll(async () => {
    await fixture.start();
    store = new DiscoveryStore(fixture.database, accountActivityStub);
    discovery = new DiscoveryService(
      new DiscoveryRepository(fixture.database),
      store,
      new MatchesService(
        new MatchesRepository(fixture.database),
        new MatchMessageRepository(fixture.database),
        photos as never,
      ),
      legalConfig() as never,
    );
  });

  afterEach(() => fixture.reset());
  afterAll(() => fixture.stop());

  it('stores likes and passes in the canonical relation with exact retention metadata', async () => {
    const [actorId, likedId, passedId] = await readyUsers(3);

    await expect(discovery.swipe(actorId, likedId, 'like')).resolves.toMatchObject({ decision: 'like', matched: false });
    await expect(discovery.swipe(actorId, passedId, 'pass')).resolves.toEqual({ decision: 'pass', matched: false });

    const rows = (await fixture.pool.query(`
      SELECT actor_id, target_id, decision, swiped_at, expires_at
      FROM swipe_decision WHERE actor_id = $1 ORDER BY target_id
    `, [actorId])).rows;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.decision).sort()).toEqual(['like', 'pass']);
    expect(rows.every((row) => row.expires_at.getTime() - row.swiped_at.getTime() === 365 * 24 * 60 * 60 * 1_000)).toBe(true);
  });

  it('keeps exactly one immutable decision under conflicting concurrent calls', async () => {
    const [actorId, targetId] = await readyUsers(2);
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => (
      store.recordSwipe(actorId, targetId, index % 2 === 0 ? 'like' : 'pass')
    )));
    const stored = await store.findSwipe(actorId, targetId);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.decision))).toEqual(new Set([stored!.decision]));
    expect((await fixture.pool.query(`SELECT count(*)::integer AS count FROM swipe_decision
      WHERE actor_id = $1 AND target_id = $2`, [actorId, targetId])).rows[0].count).toBe(1);
  });

  it('creates exactly one match for simultaneous mutual likes', async () => {
    const [firstId, secondId] = await readyUsers(2);

    const results = await Promise.all([
      discovery.swipe(firstId, secondId, 'like'),
      discovery.swipe(secondId, firstId, 'like'),
    ]);
    const matchCount = await fixture.pool.query<{ count: number }>(`
      SELECT count(*)::integer AS count FROM match_init
      WHERE (user1_id = $1 AND user2_id = $2) OR (user1_id = $2 AND user2_id = $1)
    `, [firstId, secondId]);

    expect(results.some((result) => result.matched)).toBe(true);
    expect(matchCount.rows[0]?.count).toBe(1);
  });

  it('excludes every current swipe from the feed in one PostgreSQL lookup', async () => {
    const users = await readyUsers(12);
    const [viewerId, swipedId] = users;
    await discovery.swipe(viewerId, swipedId, 'pass');

    const feed = await discovery.feed(viewerId, 100);

    expect(feed.profiles).toHaveLength(10);
    expect(feed.profiles.map((profile) => profile.user_id)).not.toContain(swipedId);
  });

  it('allows a new decision after the fixed retention and ignores the expired row in the feed', async () => {
    const [actorId, targetId] = await readyUsers(2);
    await fixture.pool.query(`
      INSERT INTO swipe_decision (actor_id, target_id, decision, swiped_at, expires_at)
      VALUES ($1, $2, 'pass', now() - interval '366 days', now() - interval '1 day')
    `, [actorId, targetId]);

    expect((await discovery.feed(actorId, 100)).profiles.map((profile) => profile.user_id)).toContain(targetId);
    await expect(discovery.swipe(actorId, targetId, 'like')).resolves.toMatchObject({ decision: 'like' });
    await expect(store.findSwipe(actorId, targetId)).resolves.toMatchObject({ decision: 'like' });
  });

  it('exports only outgoing decisions inside the PostgreSQL repeatable-read snapshot', async () => {
    const [exportedId, outgoingTargetId, incomingActorId] = await readyUsers(3);
    await store.recordSwipe(exportedId, outgoingTargetId, 'pass');
    await store.recordSwipe(incomingActorId, exportedId, 'like');
    const directory = await mkdtemp(join(tmpdir(), 'histae-postgres-discovery-'));
    const path = join(directory, 'export.json');
    const file = await open(path, 'wx', 0o600);
    try {
      const writer = new JsonExportWriter(file, 1_048_576);
      await writer.startObject();
      const snapshot = await new DataExportRepository(fixture.database).writeSnapshot(exportedId, writer, 1);
      await writer.endObject();
      await file.close();
      const body = JSON.parse(await readFile(path, 'utf8')) as {
        discovery_actions: { outgoing: Array<{ actor_id: string; target_id: string; decision: string }> };
      };

      expect(snapshot.discoveryRows).toBe(1);
      expect(body.discovery_actions.outgoing).toEqual([
        expect.objectContaining({ actor_id: exportedId, target_id: outgoingTargetId, decision: 'pass' }),
      ]);
      expect(JSON.stringify(body.discovery_actions)).not.toContain(incomingActorId);
    } finally {
      await file.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('enforces relational integrity for invalid, self-directed and duplicate rows', async () => {
    const [actorId, targetId] = await readyUsers(2);
    await expect(fixture.pool.query(`INSERT INTO swipe_decision
      (actor_id, target_id, decision, swiped_at, expires_at)
      VALUES ($1, $2, 'other', now(), now() + interval '365 days')`, [actorId, targetId]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(fixture.pool.query(`INSERT INTO swipe_decision
      (actor_id, target_id, decision, swiped_at, expires_at)
      VALUES ($1, $1, 'like', now(), now() + interval '365 days')`, [actorId]))
      .rejects.toMatchObject({ code: '23514' });
    await store.recordSwipe(actorId, targetId, 'like');
    await expect(fixture.pool.query(`INSERT INTO swipe_decision
      (actor_id, target_id, decision, swiped_at, expires_at)
      VALUES ($1, $2, 'like', now(), now() + interval '365 days')`, [actorId, targetId]))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('keeps every discovery access pattern eligible for its dedicated index', async () => {
    const [actorId, firstTargetId, secondTargetId] = await readyUsers(3);
    await store.recordSwipe(actorId, firstTargetId, 'like');
    await store.recordSwipe(actorId, secondTargetId, 'pass');
    const client = await fixture.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      await client.query('SET LOCAL enable_sort = off');
      const rendered = [
        await client.query(`EXPLAIN (FORMAT JSON) SELECT decision FROM swipe_decision
          WHERE actor_id = $1 AND target_id = $2 AND expires_at > clock_timestamp()`, [actorId, firstTargetId]),
        await client.query(`EXPLAIN (FORMAT JSON) SELECT target_id FROM swipe_decision
          WHERE actor_id = $1 AND target_id = ANY($2::uuid[]) AND expires_at > clock_timestamp()`,
        [actorId, [firstTargetId, secondTargetId]]),
        await client.query(`EXPLAIN (FORMAT JSON) SELECT actor_id, target_id, decision, swiped_at
          FROM swipe_decision WHERE actor_id = $1 AND expires_at > transaction_timestamp()
          ORDER BY swiped_at, target_id LIMIT 100`, [actorId]),
        await client.query(`EXPLAIN (FORMAT JSON) SELECT actor_id, target_id FROM swipe_decision
          WHERE target_id = $1 ORDER BY actor_id LIMIT 1000`, [firstTargetId]),
        await client.query(`EXPLAIN (FORMAT JSON) SELECT actor_id, target_id FROM swipe_decision
          WHERE expires_at <= clock_timestamp() ORDER BY expires_at, actor_id, target_id LIMIT 1000`),
      ].map((plan) => JSON.stringify(plan.rows));
      expect(rendered[0]).toMatch(/swipe_decision_pkey|idx_swipe_decision_target_actor/);
      expect(rendered[1]).toMatch(/swipe_decision_pkey|idx_swipe_decision_target_actor/);
      expect(rendered[2]).toContain('idx_swipe_decision_actor_swiped_target');
      expect(rendered[3]).toContain('idx_swipe_decision_target_actor');
      expect(rendered[4]).toContain('idx_swipe_decision_expires');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  async function readyUsers(count: number): Promise<string[]> {
    const ids = Array.from({ length: count }, () => randomUUID());
    await fixture.pool.query(`
      INSERT INTO user_account (user_id, role, phone_number_hash, phone_number_encrypted)
      SELECT id, 'user', 'postgres-discovery-test-' || id::text, ''::bytea FROM unnest($1::uuid[]) AS id
    `, [ids]);
    await fixture.pool.query(`
      INSERT INTO user_profile (user_id, firstname, birthdate, sex, bio)
      SELECT id, 'Postgres ' || ordinal::text, DATE '1990-01-01',
        CASE WHEN ordinal % 2 = 0 THEN 'female' ELSE 'male' END, 'integration test'
      FROM unnest($1::uuid[]) WITH ORDINALITY AS users(id, ordinal)
    `, [ids]);
    await fixture.pool.query(`
      INSERT INTO user_preferences (user_id, min_age, max_age, max_distance_km, looking_for)
      SELECT id, 18, 99, 500, 'both' FROM unnest($1::uuid[]) AS id
    `, [ids]);
    await fixture.pool.query(`
      INSERT INTO user_presence (user_id, latitude, longitude, is_location_fresh, updated_at)
      SELECT id, 48.856600 + ordinal * 0.001, 2.352200, true, clock_timestamp()
      FROM unnest($1::uuid[]) WITH ORDINALITY AS users(id, ordinal)
    `, [ids]);
    await fixture.pool.query(`
      INSERT INTO user_consent (user_id, consent_type, granted, document_version)
      SELECT id, consent_type, true, $2
      FROM unnest($1::uuid[]) AS id
      CROSS JOIN unnest(ARRAY['sensitive_data_consent', 'location_consent']::text[]) AS consent_type
    `, [ids, LEGAL_VERSION]);
    return ids;
  }
});

function legalConfig(): object {
  return {
    legal: {
      sensitiveDataConsentVersion: LEGAL_VERSION,
      locationConsentVersion: LEGAL_VERSION,
    },
  };
}
