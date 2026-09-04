import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CONSOLIDATED_BASELINE_VERSION = '001_baseline_20260901';

export const LEGACY_MIGRATION_VERSIONS = [
  '001_api_contract.sql',
  '002_privacy_and_schema_parity.sql',
  '003_legal_choice_semantics.sql',
  '004_consent_event_order.sql',
  '005_strict_profile_age.sql',
  '006_privacy_workflows.sql',
  '007_keyset_pagination_indexes.sql',
  '008_index_cleanup.sql',
  '009_otp_sms_delivery.sql',
  '010_single_usable_otp.sql',
  '011_mobile_client_contract.sql',
  '012_stripe_billing.sql',
  '013_preserve_stripe_trial_history.sql',
  '014_billing_event_order.sql',
  '015_private_profile_photos.sql',
] as const;

export const migrations = [{
  version: CONSOLIDATED_BASELINE_VERSION,
  filenames: ['schema_postgres.sql', 'insert_postgres.sql'],
}, {
  version: '002_user_photo_lifecycle',
  filenames: ['002_user_photo_lifecycle.sql'],
}, {
  version: '003_photo_idempotency_and_outbox',
  filenames: ['003_photo_idempotency_and_outbox.sql'],
}, {
  version: '004_admin_photo_reconciliation',
  filenames: ['004_admin_photo_reconciliation.sql'],
}, {
  version: '005_profile_questions',
  filenames: ['005_profile_questions.sql'],
}, {
  version: '006_content_moderation',
  filenames: ['006_content_moderation.sql'],
}, {
  version: '007_native_admin_webauthn',
  filenames: ['007_native_admin_webauthn.sql'],
}, {
  version: '008_internal_operations',
  filenames: ['008_internal_operations.sql'],
}, {
  version: '009_sql_performance_indexes',
  filenames: ['009_sql_performance_indexes.sql'],
}, {
  version: '010_mobile_refresh_sessions',
  filenames: ['010_mobile_refresh_sessions.sql'],
}, {
  version: '011_durable_notifications',
  filenames: ['011_durable_notifications.sql'],
}, {
  version: '012_notification_eligibility',
  filenames: ['012_notification_eligibility.sql'],
}, {
  version: '013_resumable_account_erasure',
  filenames: ['013_resumable_account_erasure.sql'],
}] as const;

export type LegacyHistoryState = 'fresh' | 'complete' | 'partial';

export function legacyHistoryState(appliedVersions: readonly string[]): LegacyHistoryState {
  const applied = new Set(appliedVersions);
  const count = LEGACY_MIGRATION_VERSIONS.filter((version) => applied.has(version)).length;
  if (count === 0) return 'fresh';
  return count === LEGACY_MIGRATION_VERSIONS.length ? 'complete' : 'partial';
}

export async function loadMigration(migration: typeof migrations[number]): Promise<{ sql: string; checksum: string }> {
  const sources = await Promise.all(migration.filenames.map(async (filename) => ({
    filename,
    contents: await readFile(join(process.cwd(), 'db', filename), 'utf8'),
  })));
  const sql = sources
    .map(({ filename, contents }) => `-- source: ${filename}\n${contents.trim()}\n`)
    .join('\n');
  return { sql, checksum: createHash('sha256').update(sql).digest('hex') };
}
