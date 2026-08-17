import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { ConfigService } from '../src/config/config.service';
import { loadMigration, migrations } from './migration-catalog';

const DEVELOPMENT_DATABASE = 'histae-dev';

type ResetSafetyInput = {
  environment: string;
  database: string;
  host: string;
};

async function reset(): Promise<void> {
  const config = new ConfigService();
  assertResetAllowed({
    environment: config.env,
    database: config.postgres.database,
    host: config.postgres.host,
  });

  const pool = new Pool(config.postgres);
  try {
    await pool.query('SELECT 1');
    console.warn(`Resetting PostgreSQL database ${JSON.stringify(config.postgres.database)} on ${JSON.stringify(config.postgres.host)}.`);

    const [dropSql, schemaSql, insertSql] = await Promise.all([
      readSql('drop_postgres.sql'),
      readSql('schema_postgres.sql'),
      readSql('insert_postgres.sql'),
    ]);
    const migrationFiles = await Promise.all(migrations.map(loadMigration));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const seedFakeUsers = config.env === 'development' && config.postgres.database === 'histae-dev';
      await client.query("SELECT set_config('histae.seed_fake_users', $1, true)", [seedFakeUsers ? 'on' : 'off']);
      await client.query(dropSql);
      await client.query('DROP TABLE IF EXISTS schema_migrations CASCADE');
      await client.query(schemaSql);
      await client.query(insertSql);
      await client.query('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
      for (let index = 0; index < migrations.length; index += 1) {
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
          migrations[index].version,
          migrationFiles[index].checksum,
        ]);
      }
      await client.query('COMMIT');
      if (seedFakeUsers) console.log('Seeded 400 complete fake users in histae-dev.');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    console.log('PostgreSQL database reset successfully.');
  } finally {
    await pool.end();
  }
}

async function readSql(filename: string): Promise<string> {
  return readFile(join(process.cwd(), 'db', filename), 'utf8');
}

export function assertResetAllowed(input: ResetSafetyInput): void {
  if (input.environment !== 'development') {
    throw new Error('Database reset is restricted to ENV=development.');
  }
  if (input.database !== DEVELOPMENT_DATABASE) {
    throw new Error(`Database reset only allows the ${DEVELOPMENT_DATABASE} database.`);
  }
  const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  if (!localHosts.has(input.host)) {
    throw new Error('Database reset only allows a local PostgreSQL host.');
  }
}

if (require.main === module) {
  void reset().catch((error: unknown) => {
    console.error('PostgreSQL reset failed:', error);
    process.exitCode = 1;
  });
}
