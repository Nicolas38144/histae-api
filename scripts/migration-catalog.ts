import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CONSOLIDATED_BASELINE_VERSION = '001_baseline_20260904';

export type MigrationDefinition = {
  version: string;
  filenames: readonly string[];
};

export const migrations: readonly MigrationDefinition[] = [
  {
    version: CONSOLIDATED_BASELINE_VERSION,
    filenames: ['schema_postgres.sql', 'insert_postgres.sql'],
  },
  {
    version: '015_stripe_reconciliation',
    filenames: ['015_stripe_reconciliation.sql'],
  },
];

export async function loadMigration(migration: MigrationDefinition): Promise<{ sql: string; checksum: string }> {
  const sources = await Promise.all(migration.filenames.map(async (filename) => ({
    filename,
    contents: await readFile(join(process.cwd(), 'db', filename), 'utf8'),
  })));
  const sql = sources
    .map(({ filename, contents }) => `-- source: ${filename}\n${contents.replace(/\r\n/g, '\n').trim()}\n`)
    .join('\n');
  return { sql, checksum: createHash('sha256').update(sql).digest('hex') };
}
