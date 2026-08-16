import * as dotenv from 'dotenv';
import { Pool } from 'pg';
import { ConfigService } from '../src/config/config.service';
import { loadMigration, migrations } from './migration-catalog';

const MIGRATION_LOCK = 86_302_003;

async function migrate(): Promise<void> {
  dotenv.config();
  const config = new ConfigService();
  const pool = new Pool(config.postgres);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
    let appliedCount = 0;
    for (const migration of migrations) {
      const { sql, checksum } = await loadMigration(migration);
      const applied = await client.query<{ checksum: string | null }>('SELECT checksum FROM schema_migrations WHERE version = $1', [migration.version]);
      if (applied.rows[0]) {
        if (applied.rows[0].checksum === null) {
          await client.query('UPDATE schema_migrations SET checksum = $2 WHERE version = $1', [migration.version, checksum]);
          continue;
        }
        if (applied.rows[0].checksum !== checksum) throw new Error(`migration checksum mismatch: ${migration.version}`);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [migration.version, checksum]);
        await client.query('COMMIT');
        appliedCount += 1;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    console.log(appliedCount ? `Applied ${appliedCount} PostgreSQL migration(s).` : 'PostgreSQL schema is already compatible with Histae API.');
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]);
    } finally {
      client.release();
    }
    await pool.end();
  }
}

void migrate().catch((error: unknown) => {
  console.error('PostgreSQL migration failed:', error);
  process.exitCode = 1;
});
