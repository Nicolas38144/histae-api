import { ConfigService } from '../src/config/config.service';
import { createScyllaClient } from '../src/scylla/scylla.client';

const DEVELOPMENT_KEYSPACE = 'histae_discovery';
const APPLICATION_TABLES = ['swipes_by_actor_bucket', 'swipes_by_target_bucket'] as const;

type ResetSafetyInput = {
  environment: string;
  enabled: boolean;
  keyspace: string;
  contactPoints: string[];
};

async function resetScylla(): Promise<void> {
  const config = new ConfigService();
  assertResetAllowed({
    environment: config.env,
    enabled: config.scylla.enabled,
    keyspace: config.scylla.keyspace,
    contactPoints: config.scylla.contactPoints,
  });

  const client = createScyllaClient(config.scylla);
  await client.connect();
  try {
    const schema = await client.execute(`
      SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?
    `, [config.scylla.keyspace], { prepare: true, isIdempotent: true });
    const existing = new Set(schema.rows.map((row) => String(row.get('table_name'))));
    const missing = APPLICATION_TABLES.filter((table) => !existing.has(table));
    if (missing.length) {
      throw new Error(`ScyllaDB schema is incomplete (${missing.join(', ')} missing). Run pnpm run scylla:migrate first.`);
    }

    for (const table of APPLICATION_TABLES) {
      await client.execute(`TRUNCATE TABLE ${table}`, [], { prepare: false, isIdempotent: true });
    }
    console.log(`Deleted all swipe data from ${config.scylla.keyspace}; schema and migration history were preserved.`);
  } finally {
    await client.shutdown();
  }
}

export function assertResetAllowed(input: ResetSafetyInput): void {
  if (input.environment !== 'development') {
    throw new Error('ScyllaDB reset is restricted to ENV=development.');
  }
  if (!input.enabled) throw new Error('SCYLLA_ENABLED=true is required to reset ScyllaDB.');
  if (input.keyspace !== DEVELOPMENT_KEYSPACE) {
    throw new Error(`ScyllaDB reset only allows the ${DEVELOPMENT_KEYSPACE} keyspace.`);
  }
  const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  if (!input.contactPoints.length || input.contactPoints.some((host) => !localHosts.has(host))) {
    throw new Error('ScyllaDB reset only allows local contact points.');
  }
}

if (require.main === module) {
  void resetScylla().catch((error: unknown) => {
    console.error('ScyllaDB reset failed:', error);
    process.exitCode = 1;
  });
}
