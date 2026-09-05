import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { ConfigService } from '../src/config/config.service';
import { DatabaseService } from '../src/database/database.service';
import { writeCliFailure } from './cli-output';

async function main(): Promise<void> {
  const userId = process.argv[2]?.trim();
  if (!userId || !isUUID(userId, 'all')) {
    throw new Error('usage: pnpm run admin:webauthn:bootstrap -- <admin-user-uuid>');
  }

  const config = new ConfigService();
  const database = new DatabaseService(config);
  await database.onModuleInit();
  try {
    const secret = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const secretHash = createHash('sha256').update(secret, 'utf8').digest();
    const expiresAt = new Date(Date.now() + config.adminAuth.bootstrapTtlMillis);
    const created = await database.transaction(async (client) => {
      const account = (await client.query<{ user_id: string }>(`
        SELECT user_id FROM user_account
        WHERE user_id = $1 AND role IN ('admin', 'superadmin')
          AND deleted_at IS NULL AND is_banned = false
        FOR UPDATE
      `, [userId])).rows[0];
      if (!account) return false;
      await client.query(`
        UPDATE admin_webauthn_bootstrap SET consumed_at = clock_timestamp()
        WHERE user_id = $1 AND consumed_at IS NULL
      `, [userId]);
      await client.query(`
        INSERT INTO admin_webauthn_bootstrap (id, user_id, secret_hash, expires_at)
        VALUES ($1, $2, $3, $4)
      `, [id, userId, secretHash, expiresAt]);
      await client.query(`
        INSERT INTO admin_auth_event (user_id, event_type)
        VALUES ($1, 'bootstrap_issued')
      `, [userId]);
      return true;
    });
    if (!created) throw new Error('the target account is not an active administrator');
    process.stdout.write(`Administrator enrollment token (shown once, expires ${expiresAt.toISOString()}):\n${id}:${secret}\n`);
  } finally {
    await database.onModuleDestroy();
  }
}

void main().catch((error: unknown) => {
  writeCliFailure('admin_webauthn_bootstrap_failed', error);
  process.exitCode = 1;
});
