import * as dotenv from 'dotenv';
import { Pool, type PoolClient } from 'pg';
import { ConfigService } from '../src/config/config.service';
import {
  CONSOLIDATED_BASELINE_VERSION,
  legacyHistoryState,
  loadMigration,
  migrations,
} from './migration-catalog';

const MIGRATION_LOCK = 86_302_003;

export async function migrate(): Promise<void> {
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
    await reconcileLegacyHistory(client);
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

async function reconcileLegacyHistory(client: PoolClient): Promise<void> {
  const history = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
  if (history.rows.some(({ version }) => version === CONSOLIDATED_BASELINE_VERSION)) return;

  const state = legacyHistoryState(history.rows.map(({ version }) => version));
  if (state === 'fresh') return;
  if (state === 'partial') {
    throw new Error('partial legacy migration history cannot be consolidated automatically');
  }

  await assertLegacySchemaIsCurrent(client);
  const baseline = await loadMigration(migrations[0]);
  await client.query(
    'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
    [CONSOLIDATED_BASELINE_VERSION, baseline.checksum],
  );
  console.log('Recorded the consolidated baseline for the complete legacy migration history.');
}

async function assertLegacySchemaIsCurrent(client: PoolClient): Promise<void> {
  const result = await client.query<{ compatible: boolean }>(`
    SELECT
      to_regclass('public.user_account') IS NOT NULL
      AND to_regclass('public.billing_invoice') IS NOT NULL
      AND to_regclass('public.account_deletion_token') IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'user_profile' AND column_name = 'photo'
      )
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'billing_invoice' AND column_name = 'provider_event_created_at'
      )
      AND EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_user_profile_photo_object_key' AND conrelid = 'public.user_profile'::regclass
      ) AS compatible
  `);
  if (!result.rows[0]?.compatible) {
    throw new Error('legacy migration history is complete but the PostgreSQL schema is not at the consolidated baseline');
  }
}

if (require.main === module) {
  void migrate().catch((error: unknown) => {
    console.error('PostgreSQL migration failed:', error);
    process.exitCode = 1;
  });
}
