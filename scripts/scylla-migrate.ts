import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigService } from '../src/config/config.service';
import { createScyllaClient } from '../src/scylla/scylla.client';
import { writeCliFailure } from './cli-output';

const migrations = [{ version: '001_discovery.cql', filename: '001_discovery.cql' }] as const;

async function migrate(): Promise<void> {
  const config = new ConfigService();
  if (!config.scylla.enabled) throw new Error('SCYLLA_ENABLED=true is required to migrate ScyllaDB');
  const bootstrap = createScyllaClient(config.scylla, false);
  await bootstrap.connect();
  try {
    await bootstrap.execute(`CREATE KEYSPACE IF NOT EXISTS ${config.scylla.keyspace}
      WITH replication = {'class': 'NetworkTopologyStrategy', '${config.scylla.localDataCenter}': ${config.scylla.replicationFactor}}
      AND durable_writes = true`);
  } finally {
    await bootstrap.shutdown();
  }

  const client = createScyllaClient(config.scylla);
  await client.connect();
  try {
    await client.execute(`CREATE TABLE IF NOT EXISTS scylla_schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT,
      applied_at TIMESTAMP
    )`);
    let applied = 0;
    for (const migration of migrations) {
      const sql = await readFile(join(process.cwd(), 'scylla', migration.filename), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.execute('SELECT checksum FROM scylla_schema_migrations WHERE version = ?', [migration.version], { prepare: true });
      const storedChecksum = existing.first()?.get('checksum') as string | undefined;
      if (storedChecksum) {
        if (storedChecksum !== checksum) throw new Error(`ScyllaDB migration checksum mismatch: ${migration.version}`);
        continue;
      }
      for (const statement of statements(sql)) await client.execute(statement);
      await client.execute(
        'INSERT INTO scylla_schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)',
        [migration.version, checksum, new Date()],
        { prepare: true },
      );
      applied += 1;
    }
    console.log(applied ? `Applied ${applied} ScyllaDB migration(s).` : 'ScyllaDB schema is already compatible with Histae API.');
  } finally {
    await client.shutdown();
  }
}

function statements(sql: string): string[] {
  return sql.split(';').map((statement) => statement.trim()).filter(Boolean);
}

void migrate().catch((error: unknown) => {
  writeCliFailure('scylla_migration_failed', error);
  process.exitCode = 1;
});
