import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { JwtService } from '@nestjs/jwt';
import type { ExecutionContext } from '@nestjs/common';
import { DatabaseService } from '../../src/database/database.service';
import { RefreshSessionRepository } from '../../src/auth/refresh-session.repository';
import { TokenService } from '../../src/auth/token.service';
import { JwtActiveGuard } from '../../src/auth/auth.guard';
import { MobileRepository } from '../../src/mobile/mobile.repository';
import { PrivacyRepository } from '../../src/privacy/privacy.repository';
import { AdminRepository } from '../../src/admin/admin.repository';
import { loadMigration, migrations } from '../../scripts/migration-catalog';

dotenv.config();
if (process.env.ENV !== 'development' || process.env.POSTGRES_DB !== 'histae-dev'
  || !['localhost', '127.0.0.1', '::1'].includes(process.env.POSTGRES_HOST ?? '')) {
  throw new Error('Refresh session integration tests require local development PostgreSQL histae-dev.');
}
const postgres = {
  host: process.env.POSTGRES_HOST, port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER, password: process.env.POSTGRES_PASSWORD, database: process.env.POSTGRES_DB,
  ssl: process.env.POSTGRES_SSLMODE !== 'disable',
};
const jwtConfig = {
  secret: 'integration-only-mobile-signing-key-never-used-outside-tests', activeKid: 'integration',
  verificationKeys: new Map([['integration', 'integration-only-mobile-signing-key-never-used-outside-tests']]),
  accessTtlMs: 900_000, refreshTtlMs: 3_600_000,
};

describe('PostgreSQL mobile refresh sessions', () => {
  const pool = new Pool(postgres);
  const database = new DatabaseService({ postgres } as never);
  const sessions = new RefreshSessionRepository(database);
  const tokens = new TokenService({ jwt: jwtConfig } as never, new JwtService());
  const mobile = new MobileRepository(database);
  const users: string[] = [];
  let owner: string;
  let other: string;

  async function account(): Promise<string> {
    const id = randomUUID();
    users.push(id);
    await pool.query(`INSERT INTO user_account (user_id, role, phone_number_hash, phone_number_encrypted)
      VALUES ($1, 'user', $2, $3)`, [id, `test-${id}`, Buffer.alloc(0)]);
    return id;
  }
  async function login(userId = owner) {
    const token = tokens.newRefreshToken();
    const session = await sessions.create(userId, token);
    expect(session).toBeDefined();
    return { token, session: session! };
  }
  async function state(sessionId: string) {
    return (await pool.query('SELECT revoked_at, revocation_reason FROM refresh_token_family WHERE id = $1', [sessionId])).rows[0]!;
  }
  beforeAll(async () => { await database.onModuleInit(); });
  beforeEach(async () => { owner = await account(); other = await account(); });
  afterEach(async () => {
    await pool.query('DELETE FROM data_access_log WHERE accessed_user_id = ANY($1::uuid[]) OR accessor_id = ANY($1::uuid[])', [users]);
    await pool.query('DELETE FROM user_account WHERE user_id = ANY($1::uuid[])', [users.splice(0)]);
  });
  afterAll(async () => { await database.onModuleDestroy(); await pool.end(); });

  it('creates a family and rotates to exactly one child without persisting secrets', async () => {
    const first = await login();
    const next = tokens.newRefreshToken();
    await expect(sessions.rotate(first.token.jti, first.token.hash, next)).resolves.toEqual(first.session);
    const rows = (await pool.query('SELECT * FROM refresh_tokens WHERE family_id = $1 ORDER BY created_at, id', [first.session.sessionId])).rows;
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => !row.revoked)).toHaveLength(1);
    expect(rows.find((row) => row.id === next.id)).toMatchObject({ parent_token_id: first.token.id, family_id: first.session.sessionId, revoked: false });
    expect(JSON.stringify(rows)).not.toContain(first.token.plain.split(':')[1]);
    expect(JSON.stringify(rows)).not.toContain(next.plain.split(':')[1]);
  });

  it('revokes all descendants on ancestor replay without touching other logins', async () => {
    const first = await login();
    const independent = await login();
    const child = tokens.newRefreshToken();
    const grandchild = tokens.newRefreshToken();
    await sessions.rotate(first.token.jti, first.token.hash, child);
    await sessions.rotate(child.jti, child.hash, grandchild);
    await expect(sessions.rotate(first.token.jti, first.token.hash, tokens.newRefreshToken())).resolves.toBeUndefined();
    expect(await state(first.session.sessionId)).toMatchObject({ revocation_reason: 'replay', revoked_at: expect.any(Date) });
    await expect(sessions.rotate(grandchild.jti, grandchild.hash, tokens.newRefreshToken())).resolves.toBeUndefined();
    expect((await pool.query('SELECT id FROM refresh_tokens WHERE family_id = $1 AND NOT revoked', [first.session.sessionId])).rows).toHaveLength(0);
    await expect(sessions.isActive(owner, independent.session.sessionId)).resolves.toBe(true);
  });

  it('does not let a guessed secret revoke an authentic family', async () => {
    const first = await login();
    const next = tokens.newRefreshToken();
    await sessions.rotate(first.token.jti, first.token.hash, next);
    await expect(sessions.rotate(first.token.jti, '0'.repeat(64), tokens.newRefreshToken())).resolves.toBeUndefined();
    await expect(sessions.isActive(owner, first.session.sessionId)).resolves.toBe(true);
    await expect(sessions.rotate(next.jti, next.hash, tokens.newRefreshToken())).resolves.toEqual(first.session);
  });

  it('serializes simultaneous refreshes and commits replay revocation after one succeeds', async () => {
    const first = await login();
    const outcomes = await Promise.all([
      sessions.rotate(first.token.jti, first.token.hash, tokens.newRefreshToken()),
      sessions.rotate(first.token.jti, first.token.hash, tokens.newRefreshToken()),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await state(first.session.sessionId)).toMatchObject({ revocation_reason: 'replay' });
    await expect(sessions.isActive(owner, first.session.sessionId)).resolves.toBe(false);
  });

  it('serializes ancestor replay against rotation of its child', async () => {
    const first = await login();
    const child = tokens.newRefreshToken();
    await sessions.rotate(first.token.jti, first.token.hash, child);
    await Promise.all([
      sessions.rotate(first.token.jti, first.token.hash, tokens.newRefreshToken()),
      sessions.rotate(child.jti, child.hash, tokens.newRefreshToken()),
    ]);
    expect(await state(first.session.sessionId)).toMatchObject({ revocation_reason: 'replay' });
    expect((await pool.query('SELECT id FROM refresh_tokens WHERE family_id = $1 AND NOT revoked', [first.session.sessionId])).rows).toHaveLength(0);
  });

  it('rejects expired tokens without revoking an otherwise active family', async () => {
    const own = await login();
    const child = tokens.newRefreshToken();
    await sessions.rotate(own.token.jti, own.token.hash, child);
    await pool.query("UPDATE refresh_tokens SET expires_at = now() - INTERVAL '1 second' WHERE id = $1", [own.token.id]);
    await expect(sessions.rotate(own.token.jti, own.token.hash, tokens.newRefreshToken())).resolves.toBeUndefined();
    await expect(sessions.isActive(owner, own.session.sessionId)).resolves.toBe(true);
    await expect(sessions.rotate(child.jti, child.hash, tokens.newRefreshToken())).resolves.toEqual(own.session);
  });

  it('rolls back consumption if inserting the replacement token fails', async () => {
    const own = await login();
    const collision = { ...tokens.newRefreshToken(), jti: own.token.jti };
    await expect(sessions.rotate(own.token.jti, own.token.hash, collision)).rejects.toMatchObject({ code: '23505' });
    const row = (await pool.query('SELECT revoked, rotated_at FROM refresh_tokens WHERE id = $1', [own.token.id])).rows[0];
    expect(row).toEqual({ revoked: false, rotated_at: null });
    await expect(sessions.rotate(own.token.jti, own.token.hash, tokens.newRefreshToken())).resolves.toEqual(own.session);
  });

  it('serializes logout-all against rotation without leaving a usable descendant', async () => {
    const own = await login();
    const another = await login();
    await Promise.all([
      sessions.rotate(another.token.jti, another.token.hash, tokens.newRefreshToken()),
      sessions.revoke(owner, own.session.sessionId),
    ]);
    await expect(sessions.list(owner, 21)).resolves.toHaveLength(0);
    expect((await pool.query('SELECT id FROM refresh_tokens WHERE user_id = $1 AND NOT revoked', [owner])).rows).toHaveLength(0);
  });

  it('allows a racing logout to revoke the family even after its token rotates', async () => {
    const first = await login();
    const device = await mobile.registerDevice(owner, first.session.sessionId, `test-push-${randomUUID()}`, 'android', null);
    await Promise.all([
      sessions.rotate(first.token.jti, first.token.hash, tokens.newRefreshToken()),
      sessions.logout(owner, first.session.sessionId, first.token.jti, first.token.hash),
    ]);
    await expect(sessions.isActive(owner, first.session.sessionId)).resolves.toBe(false);
    expect((await pool.query('SELECT id FROM device_token WHERE id = $1', [device!.id])).rows).toHaveLength(0);
    await expect(mobile.registerDevice(owner, first.session.sessionId, `test-push-${randomUUID()}`, 'ios', null)).resolves.toBeUndefined();
  });

  it('rejects cross-user and cross-family logout and targeted revocation', async () => {
    const own = await login();
    const another = await login();
    const foreign = await login(other);
    await expect(sessions.logout(owner, own.session.sessionId, foreign.token.jti, foreign.token.hash)).resolves.toBe(false);
    await expect(sessions.logout(owner, own.session.sessionId, another.token.jti, another.token.hash)).resolves.toBe(false);
    await expect(sessions.revoke(owner, own.session.sessionId, foreign.session.sessionId)).resolves.toBe(0);
    await expect(sessions.isActive(other, foreign.session.sessionId)).resolves.toBe(true);
  });

  it('revokes all own sessions and push registrations but leaves another user untouched', async () => {
    const own = await login();
    await login();
    const foreign = await login(other);
    await mobile.registerDevice(owner, own.session.sessionId, `test-push-${randomUUID()}`, 'ios', null);
    await expect(sessions.revoke(owner, own.session.sessionId)).resolves.toBe(2);
    await expect(sessions.list(owner, 21)).resolves.toHaveLength(0);
    await expect(mobile.tokensForUser(owner)).resolves.toHaveLength(0);
    await expect(sessions.isActive(other, foreign.session.sessionId)).resolves.toBe(true);
  });

  it('keeps targeted revocation idempotent and prevents a revoked caller from mutating sessions', async () => {
    const own = await login();
    const target = await login();
    await expect(sessions.revoke(owner, own.session.sessionId, target.session.sessionId)).resolves.toBe(1);
    await expect(sessions.revoke(owner, own.session.sessionId, target.session.sessionId)).resolves.toBe(1);
    await expect(sessions.revoke(owner, target.session.sessionId, own.session.sessionId)).resolves.toBeUndefined();
    await expect(sessions.isActive(owner, own.session.sessionId)).resolves.toBe(true);
  });

  it('paginates sessions with a stable cursor and no duplicates', async () => {
    for (let i = 0; i < 5; i++) await login();
    const first = await sessions.list(owner, 2);
    const second = await sessions.list(owner, 10, { at: first[1]!.cursor_at, id: first[1]!.id });
    expect(second).toHaveLength(3);
    expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(5);
  });

  it('invalidates already-issued JWTs on the next guarded request', async () => {
    const own = await login();
    const bearer = await tokens.accessToken(owner, own.session.sessionId);
    const request = { headers: { authorization: `Bearer ${bearer}` } };
    const context = { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => account, getClass: () => JwtActiveGuard } as unknown as ExecutionContext;
    const guard = new JwtActiveGuard(new JwtService(), database, { jwt: jwtConfig, legal: { termsVersion: 'test', privacyVersion: 'test' } } as never, { getAllAndOverride: () => true } as never);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    await sessions.revoke(owner, own.session.sessionId);
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 401 });
  });

  it('does not revive sessions after a ban is lifted', async () => {
    const own = await login();
    await pool.query("UPDATE user_account SET role = 'admin' WHERE user_id = $1", [other]);
    const admin = new AdminRepository(database, {} as never);
    await expect(admin.setUserBan(owner, true, 'Integration safety test', other, 'admin')).resolves.toBe('updated');
    await expect(admin.setUserBan(owner, false, 'Integration safety test', other, 'admin')).resolves.toBe('updated');
    await expect(sessions.rotate(own.token.jti, own.token.hash, tokens.newRefreshToken())).resolves.toBeUndefined();
    expect(await state(own.session.sessionId)).toMatchObject({ revocation_reason: 'banned' });
  });

  it('erases session metadata through the existing account anonymization workflow', async () => {
    const own = await login();
    await mobile.registerDevice(owner, own.session.sessionId, `test-push-${randomUUID()}`, 'ios', null);
    await pool.query('SELECT fct_anonymize_user($1)', [owner]);
    expect((await pool.query('SELECT id FROM refresh_token_family WHERE user_id = $1', [owner])).rows).toHaveLength(0);
    expect((await pool.query('SELECT id FROM refresh_tokens WHERE user_id = $1', [owner])).rows).toHaveLength(0);
    await expect(mobile.tokensForUser(owner)).resolves.toHaveLength(0);
  });

  it('purges expired ancestors without deleting an active child or losing its family', async () => {
    const own = await login();
    const child = tokens.newRefreshToken();
    await sessions.rotate(own.token.jti, own.token.hash, child);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE refresh_tokens SET expires_at = now() - INTERVAL '1 day' WHERE id = $1", [own.token.id]);
      await new PrivacyRepository(database).runMaintenance(client, new Date(), 10_000);
      const rows = (await client.query('SELECT id, parent_token_id FROM refresh_tokens WHERE family_id = $1', [own.session.sessionId])).rows;
      expect(rows).toEqual([{ id: child.id, parent_token_id: null }]);
      expect((await client.query('SELECT id FROM refresh_token_family WHERE id = $1', [own.session.sessionId])).rows).toHaveLength(1);
      await client.query("UPDATE refresh_tokens SET expires_at = now() - INTERVAL '1 day' WHERE id = $1", [child.id]);
      await client.query("UPDATE refresh_token_family SET expires_at = now() - INTERVAL '1 day' WHERE id = $1", [own.session.sessionId]);
      await new PrivacyRepository(database).runMaintenance(client, new Date(), 10_000);
      expect((await client.query('SELECT id FROM refresh_token_family WHERE id = $1', [own.session.sessionId])).rows).toHaveLength(0);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('enforces family ownership and prevents multiple active tokens at the database boundary', async () => {
    const own = await login();
    await expect(pool.query('UPDATE refresh_tokens SET user_id = $1 WHERE id = $2', [other, own.token.id])).rejects.toMatchObject({ code: '23503' });
    await expect(pool.query(`INSERT INTO refresh_tokens (user_id, family_id, token_hash, jti, expires_at)
      VALUES ($1, $2, $3, $4, $5)`, [owner, own.session.sessionId, own.token.hash, randomUUID(), own.token.expiresAt])).rejects.toMatchObject({ code: '23505' });
  });

  it('migrates legacy active and revoked tokens without extending expiry', async () => {
    const client = await pool.connect();
    const schema = `refresh_migration_${randomUUID().replaceAll('-', '')}`;
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}, public`);
      for (const migration of migrations.slice(0, -1)) await client.query((await loadMigration(migration)).sql);
      const id = randomUUID();
      await client.query(`INSERT INTO user_account (user_id, role, phone_number_hash, phone_number_encrypted)
        VALUES ($1, 'user', $2, $3)`, [id, `test-${id}`, Buffer.alloc(0)]);
      const first = tokens.newRefreshToken();
      const second = tokens.newRefreshToken();
      for (const [token, revoked] of [[first, false], [second, true]] as const) {
        await client.query(`INSERT INTO refresh_tokens (id, user_id, token_hash, jti, revoked, expires_at, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)`, [token.id, id, token.hash, token.jti, revoked, token.expiresAt, token.createdAt]);
      }
      await client.query((await loadMigration(migrations.at(-1)!)).sql);
      const rows = (await client.query('SELECT * FROM refresh_token_family WHERE user_id = $1 ORDER BY id', [id])).rows;
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.id === first.id)).toMatchObject({ expires_at: first.expiresAt, revoked_at: null });
      expect(rows.find((row) => row.id === second.id)).toMatchObject({ expires_at: second.expiresAt, revocation_reason: 'legacy_revoked' });
    } finally { await client.query('ROLLBACK'); client.release(); }
  }, 30_000);
});
