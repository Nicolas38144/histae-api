import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import { DatabaseService } from '../../src/database/database.service';
import { loadMigration, migrations } from '../../scripts/migration-catalog';

export function localPostgresConfig() {
  dotenv.config({ quiet: true });
  if (process.env.ENV !== 'development' || process.env.POSTGRES_DB !== 'histae-dev'
    || !['localhost', '127.0.0.1', '::1'].includes(process.env.POSTGRES_HOST ?? '')) {
    throw new Error('Integration fixtures require local development PostgreSQL histae-dev.');
  }
  return {
    host: process.env.POSTGRES_HOST, port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USER, password: process.env.POSTGRES_PASSWORD, database: process.env.POSTGRES_DB,
    ssl: process.env.POSTGRES_SSLMODE !== 'disable', connectionTimeoutMillis: 5_000,
  };
}

/** Never run unscoped fixture cleanup or fault injection against public. */
export class IsolatedPostgres {
  readonly schema = `r03_test_${randomUUID().replaceAll('-', '')}`;
  readonly config = { ...localPostgresConfig(), options: `-c search_path=${this.schema},public`,
    application_name: this.schema, statement_timeout: 10_000 };
  readonly database = new DatabaseService({ postgres: this.config } as never);
  readonly pool = new Pool(this.config);
  private readonly admin = new Pool(localPostgresConfig());
  private created = false;

  async start(throughVersion: typeof migrations[number]['version'] = migrations.at(-1)!.version) {
    await this.admin.query(`CREATE SCHEMA ${this.schema}`);
    this.created = true;
    for (const migration of migrations) {
      await this.database.transaction(async client => { await client.query((await loadMigration(migration)).sql); });
      if (migration.version === throughVersion) break;
    }
  }

  async reset() {
    if (!this.created || (await this.pool.query('SELECT current_schema() AS name')).rows[0]?.name !== this.schema) {
      throw new Error('Refused cleanup outside the isolated fixture schema.');
    }
    await this.pool.query('DELETE FROM match_init');
    await this.pool.query('DELETE FROM data_access_log');
    await this.pool.query('DELETE FROM outbox_operator_action');
    await this.pool.query('DELETE FROM outbox_event');
    await this.pool.query('DELETE FROM user_account');
    await this.pool.query('DELETE FROM account_tombstone');
    await this.pool.query('DELETE FROM otp_verification');
  }

  async stop() {
    await this.database.onModuleDestroy();
    await this.pool.end();
    if (this.created && /^r03_test_[a-f0-9]{32}$/.test(this.schema)) await this.admin.query(`DROP SCHEMA ${this.schema} CASCADE`);
    await this.admin.end();
  }

  async account(id: string = randomUUID()) {
    await this.pool.query(`INSERT INTO user_account(user_id, phone_number_hash, phone_number_encrypted)
      VALUES ($1, $2, $3)`, [id, `r03-${id}`, Buffer.alloc(0)]);
    await this.pool.query(`INSERT INTO user_profile(user_id, firstname, birthdate, sex)
      VALUES ($1, 'Fixture', '1990-01-01', 'male')`, [id]);
    return id;
  }

  async match(first: string, second: string, status = 'awaiting_continuation') {
    const id = randomUUID();
    const pair = [first, second].sort();
    await this.pool.query(`INSERT INTO match_init(id, user1_id, user2_id, status, expires_at)
      VALUES ($1,$2,$3,$4,clock_timestamp() + interval '1 hour')`, [id, ...pair, status]);
    await this.pool.query('INSERT INTO match_state(match_id,user_id) VALUES ($1,$2),($1,$3)', [id, ...pair]);
    return id;
  }
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

export async function eventually(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < until);
  throw new Error('Timed out waiting for the expected fixture state.');
}
