import { readdir, readFile } from 'node:fs/promises';
import { CONSOLIDATED_BASELINE_VERSION, loadMigration, migrations } from '../../../scripts/migration-catalog';

describe('PostgreSQL migration catalog', () => {
  it('loads the consolidated baseline with portable checksums and reference data', async () => {
    expect(migrations).toHaveLength(2);
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
      .toEqual(['017_postgres_discovery.sql', 'drop_postgres.sql', 'insert_postgres.sql', 'schema_postgres.sql']);
  });

  it('adds PostgreSQL discovery as migration 017 without modifying the frozen baseline', async () => {
    expect(migrations[1]).toEqual({
      version: '017_postgres_discovery',
      filenames: ['017_postgres_discovery.sql'],
    });
    const { sql, checksum } = await loadMigration(migrations[1]);
    for (const invariant of [
      'CREATE TABLE swipe_decision',
      'swipe_decision_pkey',
      'idx_swipe_decision_target_actor',
      'idx_swipe_decision_actor_swiped_target',
      'idx_swipe_decision_expires',
      'trg_live_swipe',
    ]) expect(sql).toContain(invariant);
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('defines Stripe reconciliation directly in the consolidated baseline', async () => {
    const { sql, checksum } = await loadMigration(migrations[0]);
    expect(sql).toContain('projection_version');
    expect(sql).toContain('stripe_reconciliation_due_at');
    expect(sql).toContain("'billing'::text");
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('defines bounded workload progress and export indexes directly in the baseline', async () => {
    const { sql, checksum } = await loadMigration(migrations[0]);
    expect(sql).toContain('batch_count');
    expect(sql).toContain('work_remaining');
    expect(sql).toContain('idx_match_init_user1_created');
    expect(sql).toContain('idx_user_report_match_created');
    expect(sql).toContain('idx_user_consent_user_event');
    expect(sql).toContain('idx_billing_invoice_user_created_id');
    expect(checksum).toMatch(/^[0-9a-f]{64}$/);
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
