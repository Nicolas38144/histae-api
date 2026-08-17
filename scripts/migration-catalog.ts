import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const migrations = [
  { version: '001_api_contract.sql', filename: '001_api_contract.sql' },
  { version: '002_privacy_and_schema_parity.sql', filename: '002_privacy_and_schema_parity.sql' },
  { version: '003_legal_choice_semantics.sql', filename: '003_legal_choice_semantics.sql' },
  { version: '004_consent_event_order.sql', filename: '004_consent_event_order.sql' },
  { version: '005_strict_profile_age.sql', filename: '005_strict_profile_age.sql' },
  { version: '006_privacy_workflows.sql', filename: '006_privacy_workflows.sql' },
  { version: '007_keyset_pagination_indexes.sql', filename: '007_keyset_pagination_indexes.sql' },
  { version: '008_index_cleanup.sql', filename: '008_index_cleanup.sql' },
  { version: '009_otp_sms_delivery.sql', filename: '009_otp_sms_delivery.sql' },
  { version: '010_single_usable_otp.sql', filename: '010_single_usable_otp.sql' },
] as const;

export async function loadMigration(migration: typeof migrations[number]): Promise<{ sql: string; checksum: string }> {
  const sql = await readFile(join(process.cwd(), 'db', migration.filename), 'utf8');
  return { sql, checksum: createHash('sha256').update(sql).digest('hex') };
}
