import * as dotenv from 'dotenv';
import { Pool, type PoolClient } from 'pg';
import { ConfigService } from '../src/config/config.service';
import { loadMigration, migrations } from './migration-catalog';
import { writeCliFailure } from './cli-output';

const MIGRATION_LOCK = 86_302_003;

export async function migrate(): Promise<void> {
  dotenv.config();
  const pool = new Pool(new ConfigService().postgres);
  try {
    const client = await pool.connect();
    try {
      const applied = await applyMigrations(client);
      console.log(applied ? `Applied ${applied} PostgreSQL migration(s).` : 'PostgreSQL schema is already compatible with Histae API.');
    } finally { client.release(); }
  } finally { await pool.end(); }
}

type MigrationHistoryRow = { version: string; checksum: string | null };

/** Shared by the CLI and isolated integration tests. No implicit reset or checksum repair. */
export async function applyMigrations(client: PoolClient): Promise<number> {
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const history = (await client.query<MigrationHistoryRow>('SELECT version, checksum FROM schema_migrations')).rows;
    const knownVersions = new Set<string>(migrations.map(migration => migration.version));
    for (const row of history) {
      if (!knownVersions.has(row.version)) throw new Error(`unknown PostgreSQL migration: ${row.version}`);
    }
    let appliedCount = 0;
    for (const migration of migrations) {
      const { sql, checksum } = await loadMigration(migration);
      const applied = (await client.query<MigrationHistoryRow>(
        'SELECT version, checksum FROM schema_migrations WHERE version = $1', [migration.version],
      )).rows[0];
      if (applied) {
        if (applied.checksum !== checksum) throw new Error(`migration checksum mismatch: ${migration.version}`);
        continue;
      }
      await transaction(client, async () => {
        if (migration === migrations[0]) {
          if (await applicationSchemaHasObjects(client)) {
            throw new Error('nonempty PostgreSQL schema without a complete migration history; refusing to apply the baseline');
          }
          // Development users are opt-in via the protected reset, never via ordinary migration.
          await client.query("SELECT set_config('histae.seed_fake_users', 'off', true)");
        }
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [migration.version, checksum]);
      });
      appliedCount += 1;
    }
    return appliedCount;
  } finally { await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]); }
}

async function applicationSchemaHasObjects(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=current_schema() AND c.relname <> 'schema_migrations'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d
          WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
        AND NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class owner ON owner.oid=i.indrelid
          WHERE i.indexrelid=c.oid AND owner.relnamespace=n.oid AND owner.relname='schema_migrations')
      UNION ALL
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=current_schema()
        AND NOT EXISTS (SELECT 1 FROM pg_depend d
          WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
    ) AS present
  `);
  return result.rows[0].present;
}

async function transaction(client: PoolClient, operation: () => Promise<void>): Promise<void> {
  await client.query('BEGIN');
  try { await operation(); await client.query('COMMIT'); }
  catch (error) { await client.query('ROLLBACK'); throw error; }
}

if (require.main === module) {
  void migrate().catch((error: unknown) => {
    writeCliFailure('postgres_migration_failed', error);
    process.exitCode = 1;
  });
}
