import {
  LEGACY_MIGRATION_VERSIONS,
  legacyHistoryState,
  loadMigration,
  migrations,
} from '../../../scripts/migration-catalog';

describe('PostgreSQL migration catalog', () => {
  it('builds the consolidated baseline followed by incremental migrations', async () => {
    expect(migrations).toHaveLength(7);
    const migration = await loadMigration(migrations[0]);
    expect(migration.sql).toContain('-- source: schema_postgres.sql');
    expect(migration.sql).toContain('CREATE TABLE user_account');
    expect(migration.sql).toContain('-- source: insert_postgres.sql');
    expect(migration.sql).toContain('INSERT INTO subscription_plan');
    expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);

    const photos = await loadMigration(migrations[1]);
    expect(photos.sql).toContain('-- source: 002_user_photo_lifecycle.sql');
    expect(photos.sql).toContain('CREATE TABLE user_photo');
    expect(photos.checksum).toMatch(/^[0-9a-f]{64}$/);

    const outbox = await loadMigration(migrations[2]);
    expect(outbox.sql).toContain(
      '-- source: 003_photo_idempotency_and_outbox.sql',
    );
    expect(outbox.sql).toContain('CREATE TABLE photo_upload_request');
    expect(outbox.sql).toContain('CREATE TABLE outbox_event');
    expect(outbox.checksum).toMatch(/^[0-9a-f]{64}$/);

    const reconciliation = await loadMigration(migrations[3]);
    expect(reconciliation.sql).toContain(
      '-- source: 004_admin_photo_reconciliation.sql',
    );
    expect(reconciliation.sql).toContain('admin_reconcile_photo');
    expect(reconciliation.checksum).toMatch(/^[0-9a-f]{64}$/);

    const profileQuestions = await loadMigration(migrations[4]);
    expect(profileQuestions.sql).toContain('-- source: 005_profile_questions.sql');
    expect(profileQuestions.sql).toContain('CREATE TABLE profile_question');
    expect(profileQuestions.sql).toContain('CREATE TABLE user_profile_answer');
    expect(profileQuestions.sql).toContain('ON DELETE CASCADE');
    expect(profileQuestions.checksum).toMatch(/^[0-9a-f]{64}$/);

    const moderation = await loadMigration(migrations[5]);
    expect(moderation.sql).toContain('-- source: 006_content_moderation.sql');
    expect(moderation.sql).toContain('CREATE TABLE content_moderation_case');
    expect(moderation.sql).toContain('view_moderation_content');
    expect(moderation.checksum).toMatch(/^[0-9a-f]{64}$/);

    const adminWebAuthn = await loadMigration(migrations[6]);
    expect(adminWebAuthn.sql).toContain('-- source: 007_native_admin_webauthn.sql');
    expect(adminWebAuthn.sql).toContain('CREATE TABLE admin_webauthn_credential');
    expect(adminWebAuthn.sql).toContain('CREATE TABLE admin_session');
    expect(adminWebAuthn.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('distinguishes fresh, complete and unsafe partial legacy histories', () => {
    expect(legacyHistoryState([])).toBe('fresh');
    expect(legacyHistoryState([...LEGACY_MIGRATION_VERSIONS])).toBe('complete');
    expect(legacyHistoryState([LEGACY_MIGRATION_VERSIONS[0]])).toBe('partial');
  });
});
