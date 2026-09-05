import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { applyMigrations } from '../../scripts/migrate';
import { loadMigration, migrations } from '../../scripts/migration-catalog';
import { IsolatedPostgres } from '../helpers/isolated-postgres';

jest.setTimeout(30_000);

describe('PostgreSQL migration chain', () => {
  let fixture: IsolatedPostgres;
  beforeEach(async () => { fixture = new IsolatedPostgres(); await fixture.start({ migrate: false }); });
  afterEach(() => fixture.stop());

  async function runMigrations() {
    const client = await fixture.pool.connect();
    try { return await applyMigrations(client); } finally { client.release(); }
  }

  it('initializes a fresh schema once, without implicitly creating development users', async () => {
    expect(await runMigrations()).toBe(migrations.length);
    expect(await runMigrations()).toBe(0);
    expect((await fixture.pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows)
      .toEqual(migrations.map(({ version }) => ({ version })));
    expect((await fixture.pool.query('SELECT count(*)::int AS count FROM user_account')).rows[0].count).toBe(0);
    expect((await fixture.pool.query('SELECT count(*)::int AS count FROM profile_question')).rows[0].count).toBe(15);
  });

  it('serializes concurrent initialization', async () => {
    expect((await Promise.all([runMigrations(), runMigrations()])).sort()).toEqual([0, migrations.length]);
    expect((await fixture.pool.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count).toBe(migrations.length);
  });

  it('ignores an accidentally enabled seed setting during ordinary migrations', async () => {
    const client = await fixture.pool.connect();
    try {
      await client.query("SELECT set_config('histae.seed_fake_users','on',false)");
      expect(await applyMigrations(client)).toBe(migrations.length);
      expect((await client.query('SELECT count(*)::int AS count FROM user_account')).rows[0].count).toBe(0);
    } finally {
      await client.query("SELECT set_config('histae.seed_fake_users','off',false)");
      client.release();
    }
  });

  it('refuses a nonempty schema without history and preserves its contents', async () => {
    await fixture.pool.query("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('keep')");
    await expect(runMigrations()).rejects.toThrow('nonempty PostgreSQL schema');
    expect((await fixture.pool.query('SELECT * FROM sentinel')).rows).toEqual([{ value: 'keep' }]);
    expect((await fixture.pool.query("SELECT to_regclass(current_schema() || '.user_account') AS table_name")).rows[0].table_name).toBeNull();
  });

  it('refuses unknown history and protects migration checksums', async () => {
    await runMigrations();
    await fixture.pool.query("INSERT INTO schema_migrations(version,checksum) VALUES ('999_unknown','invalid')");
    await expect(runMigrations()).rejects.toThrow('unknown PostgreSQL migration');
    await fixture.pool.query("DELETE FROM schema_migrations WHERE version='999_unknown'");
    await fixture.pool.query("UPDATE schema_migrations SET checksum='invalid'");
    await expect(runMigrations()).rejects.toThrow('migration checksum mismatch');
    await expect(fixture.pool.query('UPDATE schema_migrations SET checksum=NULL')).rejects.toMatchObject({ code: '23502' });
  });

  it('rebuilds all application objects with the protected-reset SQL and development seeds', async () => {
    await runMigrations();
    const before = await objectNames();
    const client = await fixture.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(await readFile('db/drop_postgres.sql', 'utf8'));
      await client.query('DROP TABLE schema_migrations');
      expect(await objectNames(client)).toEqual([]);
      await client.query("SELECT set_config('histae.seed_fake_users','on',true)");
      for (const migration of migrations) await client.query((await loadMigration(migration)).sql);
      expect(await objectNames(client)).toEqual(before);
      expect((await client.query('SELECT count(*)::int AS count FROM user_account')).rows[0].count).toBe(400);
      expect((await client.query("SELECT count(*)::int AS count FROM content_moderation_case WHERE status='pending'")).rows[0].count).toBe(400);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  async function objectNames(client: Pick<PoolClient, 'query'> = fixture.pool) {
    const result = await client.query<{ kind: string; name: string }>(`
      SELECT 'relation' AS kind, c.relname::text AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=current_schema() AND c.relname <> 'schema_migrations'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d
          WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
        AND NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class owner ON owner.oid=i.indrelid
          WHERE i.indexrelid=c.oid AND owner.relnamespace=n.oid AND owner.relname='schema_migrations')
      UNION ALL
      SELECT 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname=current_schema()
        AND NOT EXISTS (SELECT 1 FROM pg_depend d
          WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
      ORDER BY kind, name
    `);
    return result.rows;
  }
});
