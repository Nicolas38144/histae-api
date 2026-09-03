import { Injectable } from '@nestjs/common';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { KeysetCursor } from '../common/pagination';
import { DatabaseService } from '../database/database.service';
import type { MobileSessionIdentity, MobileSessionRow, NewRefreshToken, StoredRefreshToken } from './auth.models';

type RevocationReason = 'replay' | 'logout' | 'logout_all' | 'user_revoked' | 'banned';

@Injectable()
export class RefreshSessionRepository {
  constructor(private readonly database: DatabaseService) {}

  async create(userId: string, token: NewRefreshToken): Promise<MobileSessionIdentity | undefined> {
    return this.database.transaction(async (client) => {
      if (!await lockActiveAccount(client, userId)) return undefined;
      const sessionId = randomUUID();
      await client.query(`
        INSERT INTO refresh_token_family (id, user_id, created_at, last_refreshed_at, expires_at)
        VALUES ($1, $2, $3, $3, $4)
      `, [sessionId, userId, token.createdAt, token.expiresAt]);
      await insertToken(client, userId, sessionId, token, null);
      return { userId, sessionId };
    });
  }

  async rotate(jti: string, hash: string, next: NewRefreshToken): Promise<MobileSessionIdentity | undefined> {
    return this.database.transaction(async (client) => {
      const token = await this.lockToken(client, jti, hash);
      if (!token || !await activeFamily(client, token.user_id, token.family_id)) return undefined;
      // A forged secret must never revoke a victim's family. Authentic rotated
      // tokens are retained until their original expiry for replay detection.
      if (token.revoked) {
        if (token.rotated_at) await revokeFamilies(client, token.user_id, 'replay', token.family_id);
        // Return rather than throw: the revocation must COMMIT before HTTP 401.
        return undefined;
      }
      await client.query(`
        UPDATE refresh_tokens SET revoked = true, rotated_at = clock_timestamp() WHERE id = $1
      `, [token.id]);
      await insertToken(client, token.user_id, token.family_id, next, token.id);
      await client.query(`
        UPDATE refresh_token_family SET last_refreshed_at = clock_timestamp(), expires_at = $2 WHERE id = $1
      `, [token.family_id, next.expiresAt]);
      return { userId: token.user_id, sessionId: token.family_id };
    });
  }

  async logout(userId: string, sessionId: string, jti: string, hash: string, deviceId?: string): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const token = await this.lockToken(client, jti, hash, userId);
      if (!token || token.family_id !== sessionId || !await activeFamily(client, userId, sessionId)) return false;
      // An authentic predecessor is sufficient for logout after a racing refresh.
      await revokeFamilies(client, userId, 'logout', sessionId);
      if (deviceId) await client.query('DELETE FROM device_token WHERE id = $1 AND user_id = $2', [deviceId, userId]);
      return true;
    });
  }

  async list(userId: string, limit: number, cursor?: KeysetCursor): Promise<MobileSessionRow[]> {
    return (await this.database.query<MobileSessionRow>(`
      SELECT id, created_at, last_refreshed_at, expires_at,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM refresh_token_family
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > statement_timestamp()
        AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
      ORDER BY created_at DESC, id DESC LIMIT $2
    `, [userId, limit, cursor?.at ?? null, cursor?.id ?? null])).rows;
  }

  async revoke(userId: string, currentSessionId: string, targetId?: string): Promise<number | undefined> {
    return this.database.transaction(async (client) => {
      if (!await lockActiveAccount(client, userId) || !await activeFamily(client, userId, currentSessionId)) return undefined;
      if (targetId) {
        const target = await client.query('SELECT id FROM refresh_token_family WHERE id = $1 AND user_id = $2', [targetId, userId]);
        if (!target.rows[0]) return 0;
      }
      const count = await revokeFamilies(client, userId, targetId ? 'user_revoked' : 'logout_all', targetId);
      return targetId ? 1 : count;
    });
  }

  async isActive(userId: string, sessionId: string): Promise<boolean> {
    return (await this.database.query(`
      SELECT family.id FROM refresh_token_family AS family
      JOIN user_account AS account ON account.user_id = family.user_id
      WHERE family.id = $1 AND family.user_id = $2 AND family.revoked_at IS NULL
        AND family.expires_at > statement_timestamp() AND account.deleted_at IS NULL AND NOT account.is_banned
    `, [sessionId, userId])).rows.length === 1;
  }

  private async lockToken(client: PoolClient, jti: string, hash: string, ownerId?: string): Promise<StoredRefreshToken | undefined> {
    const candidate = (await client.query<StoredRefreshToken>(`
      SELECT id, user_id, family_id, token_hash, jti, revoked, rotated_at, expires_at FROM refresh_tokens WHERE jti = $1
    `, [jti])).rows[0];
    if (!candidate || (ownerId && candidate.user_id !== ownerId) || !sameHash(candidate.token_hash, hash)) return undefined;
    // All mobile session mutations lock the account first, then re-read the token.
    // This also serializes logout-all, device registration, bans and anonymization.
    if (!await lockActiveAccount(client, candidate.user_id)) return undefined;
    return (await client.query<StoredRefreshToken>(`
      SELECT id, user_id, family_id, token_hash, jti, revoked, rotated_at, expires_at FROM refresh_tokens
      WHERE id = $1 AND expires_at > clock_timestamp() FOR UPDATE
    `, [candidate.id])).rows[0];
  }
}

async function lockActiveAccount(client: PoolClient, userId: string): Promise<boolean> {
  return (await client.query(`
    SELECT user_id FROM user_account WHERE user_id = $1 AND deleted_at IS NULL AND NOT is_banned FOR UPDATE
  `, [userId])).rows.length === 1;
}

async function activeFamily(client: PoolClient, userId: string, sessionId: string): Promise<boolean> {
  return (await client.query(`
    SELECT id FROM refresh_token_family WHERE id = $1 AND user_id = $2
      AND revoked_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE
  `, [sessionId, userId])).rows.length === 1;
}

async function insertToken(client: PoolClient, userId: string, sessionId: string, token: NewRefreshToken, parentId: string | null): Promise<void> {
  await client.query(`
    INSERT INTO refresh_tokens (id, user_id, family_id, parent_token_id, token_hash, jti, expires_at, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [token.id, userId, sessionId, parentId, token.hash, token.jti, token.expiresAt, token.createdAt]);
}

// Caller must hold the user_account lock. No external effects between these writes.
export async function revokeFamilies(client: PoolClient, userId: string, reason: RevocationReason, sessionId?: string): Promise<number> {
  const families = await client.query(`
    UPDATE refresh_token_family SET revoked_at = clock_timestamp(), revocation_reason = $2
    WHERE user_id = $1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id = $3)
    RETURNING id
  `, [userId, reason, sessionId ?? null]);
  await client.query(`
    UPDATE refresh_tokens SET revoked = true
    WHERE user_id = $1 AND revoked = false AND ($2::uuid IS NULL OR family_id = $2)
  `, [userId, sessionId ?? null]);
  await client.query(`
    DELETE FROM device_token WHERE user_id = $1 AND ($2::uuid IS NULL OR session_id = $2)
  `, [userId, sessionId ?? null]);
  return families.rowCount ?? 0;
}

function sameHash(stored: string, supplied: string): boolean {
  const left = Buffer.from(stored, 'utf8');
  const right = Buffer.from(supplied, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
