import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { ConfigService } from '../src/config/config.service';
import { writeCliFailure } from './cli-output';

type SeedConfig = {
  apiUrl: string;
  concurrency: number;
  app: ConfigService;
};

type SeedUserRow = {
  seed_number: number;
  user_id: string;
  sex: 'male' | 'female' | 'other';
  latitude: number;
  longitude: number;
};

export type SeedUser = {
  seedNumber: number;
  id: string;
  sex: 'male' | 'female' | 'other';
  latitude: number;
  longitude: number;
  accessToken: string;
};

type SwipePlan = {
  actor: SeedUser;
  target: SeedUser;
  decision: 'like' | 'pass';
};

type RequestOptions = { token?: string; headers?: Record<string, string> };

const EXPECTED_USER_COUNT = 400;
const USERS_PER_CITY = 50;
const SWIPES_PER_USER = 20;
const NEIGHBOURS_PER_SIDE = SWIPES_PER_USER / 2;
const FAKE_USER_NAMESPACE = '47b99d44-aed4-4b6f-9a2f-66f8655170e1';

class RequestMetrics {
  total = 0;
  succeeded = 0;
  failed = 0;

  record(success: boolean): void {
    this.total += 1;
    if (success) this.succeeded += 1;
    else this.failed += 1;
  }
}

class ApiClient {
  constructor(private readonly baseUrl: string, private readonly metrics: RequestMetrics) {}

  async post(path: string, body: unknown, options: RequestOptions = {}): Promise<unknown> {
    return this.request('POST', path, { headers: this.headers(options, true), body: JSON.stringify(body) });
  }

  async patch(path: string, body: unknown, options: RequestOptions = {}): Promise<unknown> {
    return this.request('PATCH', path, { headers: this.headers(options, true), body: JSON.stringify(body) });
  }

  async put(path: string, body: unknown, options: RequestOptions = {}): Promise<unknown> {
    return this.request('PUT', path, { headers: this.headers(options, true), body: JSON.stringify(body) });
  }

  private headers(options: RequestOptions, withJsonBody = false): Record<string, string> {
    const headers: Record<string, string> = { ...options.headers };
    if (withJsonBody) headers['content-type'] = 'application/json';
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    return headers;
  }

  private async request(method: string, path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.baseUrl), { method, ...init, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      this.metrics.record(false);
      throw new Error(`${method} ${path} failed before receiving an HTTP response: ${errorMessage(error)}`, { cause: error });
    }
    const payload = await parseResponse(response);
    this.metrics.record(response.ok);
    if (!response.ok) {
      throw new Error(`${method} ${path} returned ${response.status}: ${JSON.stringify(payload)}`);
    }
    return payload;
  }
}

async function seed(): Promise<void> {
  const config = loadConfig();
  const metrics = new RequestMetrics();
  const client = new ApiClient(config.apiUrl, metrics);
  const startedAt = performance.now();

  console.log(`Target: protected local development services | concurrency: ${config.concurrency}`);
  const users = await loadSeedUsers(config.app);
  console.log(`Loaded ${users.length} deterministic PostgreSQL users.`);

  console.log('Refreshing legal choices and locations through the API...');
  await mapConcurrent(users, config.concurrency, async (user) => {
    await client.put('/api/users/me/consents', {
      consents: [
        { consent_type: 'terms_of_service_acceptance', granted: true },
        { consent_type: 'privacy_notice_acknowledgement', granted: true },
        { consent_type: 'sensitive_data_consent', granted: true },
        { consent_type: 'location_consent', granted: true },
      ],
    }, { token: user.accessToken });
    await client.patch('/api/users/me/presence', {
      latitude: user.latitude,
      longitude: user.longitude,
    }, { token: user.accessToken });
  });

  const swipePlans = generateSwipePlans(users);
  const likes = swipePlans.filter((plan) => plan.decision === 'like').length;
  const passes = swipePlans.length - likes;
  console.log(`Creating ${swipePlans.length} swipes (${likes} likes, ${passes} passes)...`);
  await mapConcurrent(swipePlans, config.concurrency, async (plan) => {
    const result = asSwipeResult(await client.post('/api/swipes', {
      target_user_id: plan.target.id,
      decision: plan.decision,
    }, { token: plan.actor.accessToken }));
    if (result.matched) throw new Error(`Seed invariant violated: ${plan.actor.id} unexpectedly matched ${plan.target.id}.`);
  });

  const elapsedSeconds = (performance.now() - startedAt) / 1_000;
  console.log('\nFake swipe seed completed.');
  console.table({
    users: users.length,
    swipes_per_user: SWIPES_PER_USER,
    swipes: swipePlans.length,
    likes,
    passes,
    matches: 0,
    requests: metrics.total,
    successful_requests: metrics.succeeded,
    failed_requests: metrics.failed,
    duration_seconds: Number(elapsedSeconds.toFixed(2)),
    requests_per_second: Number((metrics.total / elapsedSeconds).toFixed(2)),
  });
}

function loadConfig(): SeedConfig {
  const app = new ConfigService();
  if (app.env !== 'development' || app.postgres.database !== 'histae-dev') {
    throw new Error('The fake swipe seed is restricted to ENV=development and POSTGRES_DB=histae-dev.');
  }
  if (!app.scylla.enabled) throw new Error('SCYLLA_ENABLED=true is required for the fake swipe seed.');

  const apiUrl = (process.env.SEED_API_URL ?? 'http://127.0.0.1:8080').trim();
  const parsedUrl = new URL(apiUrl);
  if (!new Set(['127.0.0.1', 'localhost', '::1']).has(parsedUrl.hostname)) {
    throw new Error('The fake swipe seed only accepts a local API target.');
  }
  return {
    apiUrl: parsedUrl.toString(),
    concurrency: positiveInteger('SEED_CONCURRENCY', 25),
    app,
  };
}

async function loadSeedUsers(config: ConfigService): Promise<SeedUser[]> {
  const pool = new Pool(config.postgres);
  try {
    const result = await pool.query<SeedUserRow>(`
      WITH expected_users AS (
        SELECT seed_number,
          uuid_generate_v5($1::uuid, 'histae-development-fake-user-' || seed_number) AS user_id
        FROM generate_series(1, $2) AS generated(seed_number)
      )
      SELECT expected_users.seed_number, account.user_id, profile.sex,
        presence.latitude::double precision AS latitude,
        presence.longitude::double precision AS longitude
      FROM expected_users
      JOIN user_account AS account USING (user_id)
      JOIN user_profile AS profile USING (user_id)
      JOIN user_preferences AS preferences USING (user_id)
      JOIN user_presence AS presence USING (user_id)
      WHERE account.deleted_at IS NULL AND account.is_banned = false
        AND profile.sex IS NOT NULL
      ORDER BY expected_users.seed_number
    `, [FAKE_USER_NAMESPACE, EXPECTED_USER_COUNT]);
    if (result.rows.length !== EXPECTED_USER_COUNT) {
      throw new Error(`Expected ${EXPECTED_USER_COUNT} complete fake users in histae-dev, found ${result.rows.length}. Run pnpm run db:reset first.`);
    }

    const jwt = new JwtService({ secret: config.jwt.secret });
    return Promise.all(result.rows.map(async (row) => {
      const sessionId = randomUUID();
      // Seed tokens obey the same session, type, audience and TTL rules as mobile.
      await pool.query(`
        INSERT INTO refresh_token_family (id, user_id, created_at, last_refreshed_at, expires_at)
        VALUES ($1, $2, now(), now(), now() + ($3::bigint * INTERVAL '1 millisecond'))
      `, [sessionId, row.user_id, config.jwt.accessTtlMs]);
      return {
      seedNumber: row.seed_number,
      id: row.user_id,
      sex: row.sex,
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      accessToken: await jwt.signAsync(
        { sub: row.user_id, sid: sessionId, typ: 'access' },
        { algorithm: 'HS256', keyid: config.jwt.activeKid, audience: 'histae-app', issuer: 'histae-api', expiresIn: Math.floor(config.jwt.accessTtlMs / 1_000) },
      ),
      };
    }));
  } finally {
    await pool.end();
  }
}

export function generateSwipePlans(users: SeedUser[]): SwipePlan[] {
  const groups = new Map<string, SeedUser[]>();
  for (const user of users) {
    const city = Math.floor((user.seedNumber - 1) / USERS_PER_CITY);
    const compatibility = user.sex === 'other' ? 'other' : 'binary';
    const key = `${city}:${compatibility}`;
    groups.set(key, [...(groups.get(key) ?? []), user]);
  }

  const plans: SwipePlan[] = [];
  for (const [key, group] of groups) {
    group.sort((left, right) => left.seedNumber - right.seedNumber);
    if (group.length <= SWIPES_PER_USER) {
      throw new Error(`Compatibility group ${key} contains ${group.length} users; at least ${SWIPES_PER_USER + 1} are required.`);
    }
    for (let actorIndex = 0; actorIndex < group.length; actorIndex += 1) {
      const actor = group[actorIndex]!;
      for (let distance = 1; distance <= NEIGHBOURS_PER_SIDE; distance += 1) {
        const next = group[(actorIndex + distance) % group.length]!;
        const previous = group[(actorIndex - distance + group.length) % group.length]!;
        plans.push({ actor, target: next, decision: decisionFor(actor, next) });
        plans.push({ actor, target: previous, decision: decisionFor(actor, previous) });
      }
    }
  }
  validateSwipePlans(users, plans);
  return plans;
}

function decisionFor(actor: SeedUser, target: SeedUser): 'like' | 'pass' {
  const first = Math.min(actor.seedNumber, target.seedNumber);
  const second = Math.max(actor.seedNumber, target.seedNumber);
  const designatedLiker = (first * 31 + second * 17) % 2 === 0 ? first : second;
  return actor.seedNumber === designatedLiker ? 'like' : 'pass';
}

function validateSwipePlans(users: SeedUser[], plans: SwipePlan[]): void {
  if (plans.length !== users.length * SWIPES_PER_USER) {
    throw new Error(`Expected ${users.length * SWIPES_PER_USER} swipe plans, generated ${plans.length}.`);
  }
  const byActor = new Map<string, Set<string>>();
  const byPair = new Map<string, SwipePlan[]>();
  for (const plan of plans) {
    const targets = byActor.get(plan.actor.id) ?? new Set<string>();
    targets.add(plan.target.id);
    byActor.set(plan.actor.id, targets);
    const pair = plan.actor.id < plan.target.id
      ? `${plan.actor.id}:${plan.target.id}`
      : `${plan.target.id}:${plan.actor.id}`;
    byPair.set(pair, [...(byPair.get(pair) ?? []), plan]);
  }
  if (users.some((user) => byActor.get(user.id)?.size !== SWIPES_PER_USER)) {
    throw new Error('Every fake user must have exactly 20 distinct swipe targets.');
  }
  if ([...byPair.values()].some((pair) => pair.length !== 2 || pair.filter((plan) => plan.decision === 'like').length !== 1)) {
    throw new Error('Every generated pair must contain exactly one like and one pass.');
  }
}

function positiveInteger(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  return Number(value);
}

async function mapConcurrent<Input, Output>(items: Input[], concurrency: number, worker: (item: Input) => Promise<Output>): Promise<Output[]> {
  const results = new Array<Output>(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function asSwipeResult(value: unknown): { matched: boolean } {
  if (!isObject(value) || typeof value.matched !== 'boolean') {
    throw new Error(`Expected a swipe response, received ${JSON.stringify(value)}.`);
  }
  return { matched: value.matched };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (require.main === module) {
  void seed().catch((error: unknown) => {
    writeCliFailure('fake_swipe_seed_failed', error);
    process.exitCode = 1;
  });
}
