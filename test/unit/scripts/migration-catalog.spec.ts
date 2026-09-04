import { readdir, readFile } from 'node:fs/promises';
import { CONSOLIDATED_BASELINE_VERSION, loadMigration, migrations } from '../../../scripts/migration-catalog';

describe('PostgreSQL consolidated migration catalog', () => {
  it('loads one complete baseline with portable checksums and reference data', async () => {
    expect(migrations).toHaveLength(1);
    expect(migrations[0].version).toBe(CONSOLIDATED_BASELINE_VERSION);
    const { sql, checksum } = await loadMigration(migrations[0]);
    for (const table of ['user_account', 'user_photo', 'photo_upload_request', 'outbox_event',
      'profile_question', 'user_profile_answer', 'content_moderation_case', 'admin_webauthn_credential',
      'admin_session', 'maintenance_job_status', 'outbox_operator_action', 'refresh_token_family',
      'notification_push_delivery', 'account_erasure']) expect(sql).toContain(`CREATE TABLE ${table} (`);
    for (const invariant of ['fk_refresh_parent', 'chk_notification_billing_context', 'trg_erase_notifications',
      'trg_live_photo', 'idx_match_init_user1_activity', 'idx_user_presence_updated', 'attempt_number',
      'customer_creation_started_at', 'INSERT INTO profile_question', 'INSERT INTO subscription_plan']) {
      expect(sql).toContain(invariant);
    }
    expect(sql).not.toContain('\r');
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
    expect((await loadMigration(migrations[0])).checksum).toBe(checksum);
    expect((await readdir('db')).filter(name => name.endsWith('.sql')).sort())
      .toEqual(['drop_postgres.sql', 'insert_postgres.sql', 'schema_postgres.sql']);
  });

  it('defines constraints with their tables and creates foreign-key parents first', async () => {
    const schema = await readFile('db/schema_postgres.sql', 'utf8');
    expect(schema).not.toMatch(/^ALTER TABLE\b/m);
    expect(schema).toContain('attempt_number bigint GENERATED ALWAYS AS IDENTITY NOT NULL');
    expect(schema).toContain('event_sequence bigserial NOT NULL');
    const tables = [...schema.matchAll(/^CREATE TABLE (\w+) \(\r?\n([\s\S]*?)^\);/gm)];
    expect(tables.length).toBeGreaterThan(0);
    const created = new Set<string>();
    for (const [, name, definition] of tables) {
      expect(definition).toMatch(/CONSTRAINT \w+ PRIMARY KEY\s*\(/);
      created.add(name); // Self-references are valid in CREATE TABLE.
      for (const [, parent] of definition.matchAll(/\bREFERENCES (\w+)\s*\(/g)) {
        expect({ table: name, parent, exists: created.has(parent) })
          .toEqual({ table: name, parent, exists: true });
      }
    }
  });
});
