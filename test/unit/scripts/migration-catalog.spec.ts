import {
  LEGACY_MIGRATION_VERSIONS,
  legacyHistoryState,
  loadMigration,
  migrations,
} from '../../../scripts/migration-catalog';

describe('PostgreSQL migration catalog', () => {
  it('builds one consolidated baseline from the canonical schema and seed catalog', async () => {
    expect(migrations).toHaveLength(1);
    const migration = await loadMigration(migrations[0]);
    expect(migration.sql).toContain('-- source: schema_postgres.sql');
    expect(migration.sql).toContain('CREATE TABLE user_account');
    expect(migration.sql).toContain('-- source: insert_postgres.sql');
    expect(migration.sql).toContain('INSERT INTO subscription_plan');
    expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('distinguishes fresh, complete and unsafe partial legacy histories', () => {
    expect(legacyHistoryState([])).toBe('fresh');
    expect(legacyHistoryState([...LEGACY_MIGRATION_VERSIONS])).toBe('complete');
    expect(legacyHistoryState([LEGACY_MIGRATION_VERSIONS[0]])).toBe('partial');
  });
});
