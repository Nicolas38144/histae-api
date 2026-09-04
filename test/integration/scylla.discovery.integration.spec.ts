import { accountActivityStub } from "../account-activity.stub";
import { randomUUID } from 'node:crypto';
import * as dotenv from 'dotenv';
import type { ArrayOrObject, Client, QueryOptions, types } from 'cassandra-driver';
import type { PoolClient, PoolConfig } from 'pg';
import { Pool } from 'pg';
import type { ApiError } from '../../src/common/api-error';
import type { ScyllaConfig } from '../../src/config/config.service';
import { DiscoveryRepository } from '../../src/discovery/discovery.repository';
import { DiscoveryService } from '../../src/discovery/discovery.service';
import { DiscoveryStore, uuidBucket } from '../../src/discovery/discovery.store';
import { MatchesRepository } from '../../src/matches/matches.repository';
import { MatchMessageRepository } from '../../src/matches/match-message.repository';
import { MatchesService } from '../../src/matches/matches.service';
import { PrivacyRepository } from '../../src/privacy/privacy.repository';
import { PrivacyService } from '../../src/privacy/privacy.service';
import { createScyllaClient } from '../../src/scylla/scylla.client';
import { ScyllaUnavailableError } from '../../src/scylla/scylla.service';

dotenv.config();

const TEST_KEYSPACE = 'histae_discovery';
const TEST_CONTACT_POINTS = (process.env.SCYLLA_CONTACT_POINTS ?? '127.0.0.1').split(',').map((value) => value.trim());
const LEGAL_VERSION = 'scylla-integration-v1';
const photos = {
  urlForKey: async (key: string | null): Promise<string | null> => key,
  deleteForAccount: jest.fn().mockResolvedValue(undefined),
};

assertDevelopmentTargets();

const postgresConfig: PoolConfig = {
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  ssl: process.env.POSTGRES_SSLMODE !== 'disable',
};

const scyllaConfig: ScyllaConfig = {
  enabled: true,
  contactPoints: TEST_CONTACT_POINTS,
  port: Number(process.env.SCYLLA_PORT ?? 9042),
  localDataCenter: process.env.SCYLLA_LOCAL_DATACENTER ?? 'datacenter1',
  keyspace: TEST_KEYSPACE,
  username: process.env.SCYLLA_USERNAME ?? '',
  password: process.env.SCYLLA_PASSWORD ?? '',
  tls: false,
  tlsCaPath: '',
  replicationFactor: 1,
  connectTimeoutMillis: 10_000,
  requestTimeoutMillis: 20_000,
};

jest.setTimeout(120_000);

describe('Discovery with real ScyllaDB and PostgreSQL development stores', () => {
  let client: Client;
  let pool: Pool;
  let store: DiscoveryStore;
  let discovery: DiscoveryService;
  let privacy: PrivacyService;
  let createdUserIds: string[];

  beforeAll(async () => {
    client = createScyllaClient(scyllaConfig);
    await client.connect();
    await assertProductionSchema(client);

    pool = new Pool(postgresConfig);
    await pool.query('SELECT 1');
    store = new DiscoveryStore(scyllaFor(client) as never, accountActivityStub);
    const database = databaseFor(pool);
    discovery = new DiscoveryService(
      new DiscoveryRepository(database as never),
      store,
      new MatchesService(new MatchesRepository(database as never), new MatchMessageRepository(database as never), photos as never),
      legalConfig() as never,
    );
    privacy = new PrivacyService(new PrivacyRepository(database as never), store, photos as never);
  });

  beforeEach(async () => {
    createdUserIds = [];
  });

  afterEach(async () => {
    await Promise.all(createdUserIds.map((userId) => store.deleteUserData(userId)));
    await deleteTestUsers(pool, createdUserIds);
  });

  afterAll(async () => {
    await pool?.end();
    await client?.shutdown();
  });

  it('creates a like and a pass in both query views', async () => {
    const [actorId, likedId, passedId] = await readyUsers(3);

    await expect(discovery.swipe(actorId, likedId, 'like')).resolves.toMatchObject({ decision: 'like', matched: false });
    await expect(discovery.swipe(actorId, passedId, 'pass')).resolves.toEqual({ decision: 'pass', matched: false });

    await expect(store.findSwipe(actorId, likedId)).resolves.toMatchObject({ actor_id: actorId, target_id: likedId, decision: 'like' });
    await expect(store.findSwipe(actorId, passedId)).resolves.toMatchObject({ actor_id: actorId, target_id: passedId, decision: 'pass' });
    expect(await targetDecision(client, likedId, actorId)).toBe('like');
    expect(await targetDecision(client, passedId, actorId)).toBe('pass');
  });

  it('keeps the first decision immutable when a conflicting retry arrives', async () => {
    const [actorId, targetId] = await readyUsers(2);
    await discovery.swipe(actorId, targetId, 'like');

    await expect(discovery.swipe(actorId, targetId, 'pass')).rejects.toMatchObject({
      status: 409,
      code: 'swipe_already_recorded',
    });
    await expect(store.findSwipe(actorId, targetId)).resolves.toMatchObject({ decision: 'like' });
    expect(await targetDecision(client, targetId, actorId)).toBe('like');
  });

  it('creates exactly one PostgreSQL match for simultaneous mutual likes', async () => {
    const [firstId, secondId] = await readyUsers(2);

    const results = await Promise.all([
      discovery.swipe(firstId, secondId, 'like'),
      discovery.swipe(secondId, firstId, 'like'),
    ]);
    const matchCount = await pool.query<{ count: number }>(`
      SELECT count(*)::integer AS count FROM match_init
      WHERE (user1_id = $1 AND user2_id = $2) OR (user1_id = $2 AND user2_id = $1)
    `, [firstId, secondId]);

    expect(results.some((result) => result.matched)).toBe(true);
    expect(matchCount.rows[0]?.count).toBe(1);
  });

  it('excludes every already-swiped profile from the feed', async () => {
    const users = await readyUsers(12);
    const [viewerId, swipedId] = users;
    await discovery.swipe(viewerId, swipedId, 'pass');

    const feed = await discovery.feed(viewerId, 100);

    expect(feed.profiles).toHaveLength(10);
    expect(feed.profiles.map((profile) => profile.user_id)).not.toContain(swipedId);
  });

  it('keeps the actor and target query views coherent', async () => {
    const [actorId, targetId] = await readyUsers(2);
    await store.recordSwipe(actorId, targetId, 'like');

    const [actorRow, targetRow] = await Promise.all([
      client.execute(`
        SELECT actor_id, target_id, decision, swiped_at FROM swipes_by_actor_bucket
        WHERE actor_id = ? AND bucket = ? AND target_id = ?
      `, [actorId, uuidBucket(targetId), targetId], { prepare: true }),
      client.execute(`
        SELECT target_id, actor_id, decision, swiped_at FROM swipes_by_target_bucket
        WHERE target_id = ? AND bucket = ? AND actor_id = ?
      `, [targetId, uuidBucket(actorId), actorId], { prepare: true }),
    ]);

    expect(String(actorRow.first()?.get('actor_id'))).toBe(actorId);
    expect(String(targetRow.first()?.get('target_id'))).toBe(targetId);
    expect(targetRow.first()?.get('decision')).toBe(actorRow.first()?.get('decision'));
    expect((targetRow.first()?.get('swiped_at') as Date).getTime()).toBe((actorRow.first()?.get('swiped_at') as Date).getTime());
  });

  it('repairs the target mirror on retry after a simulated mirror failure', async () => {
    const [actorId, targetId] = await readyUsers(2);
    let mirrorFailurePending = true;
    const failingStore = new DiscoveryStore({
      enabled: true,
      execute: async (query: string, params: unknown[] = [], options: QueryOptions = {}) => {
        if (mirrorFailurePending && query.includes('INSERT INTO swipes_by_target_bucket')) {
          mirrorFailurePending = false;
          throw new ScyllaUnavailableError('simulated target mirror failure');
        }
        return executeScylla(client, query, params, options);
      },
    } as never, accountActivityStub);

    await expect(failingStore.recordSwipe(actorId, targetId, 'like')).rejects.toBeInstanceOf(ScyllaUnavailableError);
    expect(await targetDecision(client, targetId, actorId)).toBeUndefined();

    await expect(store.recordSwipe(actorId, targetId, 'like')).resolves.toEqual({ created: false, decision: 'like' });
    expect(await targetDecision(client, targetId, actorId)).toBe('like');
  });

  it('erases every incoming and outgoing reference from both views', async () => {
    const [deletedId, outgoingTargetId, incomingActorId] = await readyUsers(3);
    await store.recordSwipe(deletedId, outgoingTargetId, 'like');
    await store.recordSwipe(incomingActorId, deletedId, 'pass');

    await store.deleteUserData(deletedId);

    await expect(store.exportOwnActions(deletedId)).resolves.toEqual([]);
    await expect(store.findSwipe(incomingActorId, deletedId)).resolves.toBeUndefined();
    expect(await targetDecision(client, outgoingTargetId, deletedId)).toBeUndefined();
    expect(await targetDecision(client, deletedId, incomingActorId)).toBeUndefined();
  });

  it('excludes third-party incoming decisions from the portable export', async () => {
    const [exportedId, outgoingTargetId, incomingActorId] = await readyUsers(3);
    await store.recordSwipe(exportedId, outgoingTargetId, 'pass');
    await store.recordSwipe(incomingActorId, exportedId, 'like');

    const exported = await privacy.exportUserData(exportedId);
    const actions = exported.discovery_actions as { outgoing: Array<{ actor_id: string; target_id: string; decision: string }> };

    expect(actions.outgoing).toEqual([
      expect.objectContaining({ actor_id: exportedId, target_id: outgoingTargetId, decision: 'pass' }),
    ]);
    expect(JSON.stringify(actions)).not.toContain(incomingActorId);
  });

  it('drains a full erasure partition in bounded batches without losing mirror references', async () => {
    const [owner] = await readyUsers(1);
    // Temporary peer UUIDs share bucket zero; no real account data is touched.
    const peers = Array.from({ length: 120 }, () => `00000000-${randomUUID().slice(9)}`);
    for (let offset = 0; offset < peers.length; offset += 20) {
      await Promise.all(peers.slice(offset, offset + 20).map((peer) => store.recordSwipe(owner!, peer, 'pass')));
    }
    await expect(store.deleteUserDataBatch(owner!, 0)).resolves.toBe(false);
    expect(await store.exportOwnActions(owner!)).toHaveLength(20);
    await expect(store.deleteUserDataBatch(owner!, 0)).resolves.toBe(true);
    await expect(store.exportOwnActions(owner!)).resolves.toEqual([]);
    for (let offset = 0; offset < peers.length; offset += 20) {
      const mirrors = await Promise.all(peers.slice(offset, offset + 20).map((peer) => targetDecision(client, peer, owner!)));
      expect(mirrors.every((decision) => decision === undefined)).toBe(true);
    }
  });

  it('expires both test rows with a short per-write TTL in the shared development keyspace', async () => {
    const [actorId, targetId] = await readyUsers(2);
    const shortTtlStore = new DiscoveryStore(shortTtlScylla(client, 2) as never, accountActivityStub);
    await shortTtlStore.recordSwipe(actorId, targetId, 'like');

    await expect(eventually(async () => {
      const [actor, target] = await Promise.all([
        store.findSwipe(actorId, targetId),
        targetDecision(client, targetId, actorId),
      ]);
      return actor === undefined && target === undefined;
    }, 12_000)).resolves.toBe(true);
  });

  it('maps a Scylla outage to the public 503 discovery error', async () => {
    const [actorId, targetId] = await readyUsers(2);
    const unavailableStore = {
      available: true,
      recordSwipe: jest.fn().mockRejectedValue(new ScyllaUnavailableError('simulated outage')),
    };
    const service = new DiscoveryService(
      new DiscoveryRepository(databaseFor(pool) as never),
      unavailableStore as never,
      new MatchesService(new MatchesRepository(databaseFor(pool) as never), new MatchMessageRepository(databaseFor(pool) as never), photos as never),
      legalConfig() as never,
    );

    const error = await service.swipe(actorId, targetId, 'like').catch((caught: ApiError) => caught);
    expect(error).toMatchObject({ status: 503, code: 'discovery_unavailable' });
  });

  async function readyUsers(count: number): Promise<string[]> {
    const ids = Array.from({ length: count }, () => randomUUID());
    createdUserIds.push(...ids);
    await insertReadyUsers(pool, ids);
    return ids;
  }
});

function assertDevelopmentTargets(): void {
  if (process.env.ENV !== 'development' || process.env.POSTGRES_DB !== 'histae-dev') {
    throw new Error('Scylla integration tests only allow ENV=development with POSTGRES_DB=histae-dev.');
  }
  const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  if (!TEST_CONTACT_POINTS.length || TEST_CONTACT_POINTS.some((host) => !localHosts.has(host))) {
    throw new Error('Scylla integration tests only allow local SCYLLA_CONTACT_POINTS.');
  }
}

async function assertProductionSchema(client: Client): Promise<void> {
  const result = await client.execute(`
    SELECT table_name, default_time_to_live
    FROM system_schema.tables
    WHERE keyspace_name = ?
  `, [TEST_KEYSPACE], { prepare: true });
  const tables = new Map(result.rows.map((row) => [String(row.get('table_name')), Number(row.get('default_time_to_live'))]));
  expect(tables.get('swipes_by_actor_bucket')).toBe(31_536_000);
  expect(tables.get('swipes_by_target_bucket')).toBe(31_536_000);
}

type TestScylla = {
  enabled: true;
  execute: (query: string, params?: ArrayOrObject, options?: QueryOptions) => Promise<types.ResultSet>;
};

function scyllaFor(client: Client): TestScylla {
  return {
    enabled: true,
    execute: (query, params = [], options = {}) => executeScylla(client, query, params, options),
  };
}

function shortTtlScylla(client: Client, ttl: number): TestScylla {
  return {
    enabled: true,
    execute: (query, params = [], options = {}) => {
      if (query.includes('INSERT INTO swipes_by_actor_bucket')) {
        return executeScylla(client, `${query.trim()} USING TTL ${ttl}`, params, options);
      }
      if (query.includes('INSERT INTO swipes_by_target_bucket') && !query.includes('USING TTL')) {
        return executeScylla(client, `${query.trim()} USING TTL ${ttl}`, params, options);
      }
      return executeScylla(client, query, params, options);
    },
  };
}

async function executeScylla(
  client: Client,
  query: string,
  params: ArrayOrObject = [],
  options: QueryOptions = {},
): Promise<types.ResultSet> {
  try {
    return await client.execute(query, params, { prepare: true, ...options });
  } catch (error) {
    if (error instanceof ScyllaUnavailableError) throw error;
    throw new ScyllaUnavailableError('ScyllaDB integration query failed', { cause: error });
  }
}

async function targetDecision(client: Client, targetId: string, actorId: string): Promise<string | undefined> {
  const result = await client.execute(`
    SELECT decision FROM swipes_by_target_bucket
    WHERE target_id = ? AND bucket = ? AND actor_id = ?
  `, [targetId, uuidBucket(actorId), actorId], { prepare: true });
  const value = result.first()?.get('decision');
  return value === undefined || value === null ? undefined : String(value);
}

type TestDatabase = {
  query: Pool['query'];
  transaction: <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;
};

function databaseFor(pool: Pool): TestDatabase {
  return {
    query: pool.query.bind(pool),
    transaction: async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

async function insertReadyUsers(pool: Pool, ids: string[]): Promise<void> {
  await pool.query(`
    INSERT INTO user_account (user_id, role, phone_number_hash, phone_number_encrypted)
    SELECT id, 'user', 'scylla-test-' || id::text, ''::bytea FROM unnest($1::uuid[]) AS id
  `, [ids]);
  await pool.query(`
    INSERT INTO user_profile (user_id, firstname, birthdate, sex, bio)
    SELECT id, 'Scylla ' || ordinal::text, DATE '1990-01-01',
      CASE WHEN ordinal % 2 = 0 THEN 'female' ELSE 'male' END, 'integration test'
    FROM unnest($1::uuid[]) WITH ORDINALITY AS users(id, ordinal)
  `, [ids]);
  await pool.query(`
    INSERT INTO user_preferences (user_id, min_age, max_age, max_distance_km, looking_for)
    SELECT id, 18, 99, 500, 'both' FROM unnest($1::uuid[]) AS id
  `, [ids]);
  await pool.query(`
    INSERT INTO user_presence (user_id, latitude, longitude, is_location_fresh, updated_at)
    SELECT id, 48.856600 + ordinal * 0.001, 2.352200, true, clock_timestamp()
    FROM unnest($1::uuid[]) WITH ORDINALITY AS users(id, ordinal)
  `, [ids]);
  await pool.query(`
    INSERT INTO user_consent (user_id, consent_type, granted, document_version)
    SELECT id, consent_type, true, $2
    FROM unnest($1::uuid[]) AS id
    CROSS JOIN unnest(ARRAY['sensitive_data_consent', 'location_consent']::text[]) AS consent_type
  `, [ids, LEGAL_VERSION]);
}

async function deleteTestUsers(pool: Pool, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await pool.query('DELETE FROM data_access_log WHERE accessed_user_id = ANY($1::uuid[]) OR accessor_id = ANY($1::uuid[])', [ids]);
  await pool.query('DELETE FROM user_account WHERE user_id = ANY($1::uuid[])', [ids]);
}

function legalConfig(): object {
  return {
    legal: {
      sensitiveDataConsentVersion: LEGAL_VERSION,
      locationConsentVersion: LEGAL_VERSION,
    },
  };
}

async function eventually(check: () => Promise<boolean>, timeoutMillis: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMillis;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}
