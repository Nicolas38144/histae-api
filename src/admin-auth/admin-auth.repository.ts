import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import type { AdminRole } from './admin-auth.models';

export type BootstrapRow = QueryResultRow & {
  id: string;
  user_id: string;
  role: AdminRole;
};

export type ChallengePurpose = 'bootstrap_registration' | 'additional_registration' | 'authentication';
export type ChallengeRow = QueryResultRow & {
  id: string;
  user_id: string | null;
  bootstrap_id: string | null;
  challenge_hash: Buffer;
};

export type CredentialRow = QueryResultRow & {
  id: string;
  user_id: string;
  role: AdminRole;
  credential_id: string;
  public_key: Buffer;
  counter: string;
  device_type: 'singleDevice' | 'multiDevice';
  backed_up: boolean;
  transports: string[];
  aaguid: string | null;
  name: string;
  created_at: Date;
  last_used_at: Date | null;
};

export type ActiveSessionRow = QueryResultRow & {
  id: string;
  user_id: string;
  credential_id: string;
  role: AdminRole;
  authenticated_at: Date;
  expires_at: Date;
};

export type NewCredential = {
  credentialId: string;
  publicKey: Buffer;
  counter: number;
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  transports: string[];
  aaguid: string | null;
  name: string;
};

export type NewSession = {
  tokenHash: Buffer;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
};

export type CredentialRevocationResult = 'revoked' | 'not_found' | 'last_credential';

type AdminAuthEventType =
  | 'bootstrap_issued'
  | 'bootstrap_registered'
  | 'login_succeeded'
  | 'credential_added'
  | 'credential_revoked'
  | 'other_sessions_revoked'
  | 'logout';

@Injectable()
export class AdminAuthRepository {
  constructor(private readonly database: DatabaseService) {}

  async bootstrap(bootstrapId: string, secretHash: Buffer): Promise<BootstrapRow | undefined> {
    return (await this.database.query<BootstrapRow>(`
      SELECT bootstrap.id, bootstrap.user_id, account.role
      FROM admin_webauthn_bootstrap AS bootstrap
      JOIN user_account AS account ON account.user_id = bootstrap.user_id
      WHERE bootstrap.id = $1 AND bootstrap.secret_hash = $2
        AND bootstrap.consumed_at IS NULL AND bootstrap.expires_at > clock_timestamp()
        AND account.role IN ('admin', 'superadmin')
        AND account.deleted_at IS NULL AND account.is_banned = false
    `, [bootstrapId, secretHash])).rows[0];
  }

  async createChallenge(input: {
    purpose: ChallengePurpose;
    challengeHash: Buffer;
    userId?: string;
    bootstrapId?: string;
    expiresAt: Date;
  }): Promise<string> {
    const result = await this.database.query<{ id: string }>(`
      INSERT INTO admin_webauthn_challenge (purpose, challenge_hash, user_id, bootstrap_id, expires_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `, [input.purpose, input.challengeHash, input.userId ?? null, input.bootstrapId ?? null, input.expiresAt]);
    return result.rows[0]!.id;
  }

  async consumeChallenge(
    challengeId: string,
    purpose: ChallengePurpose,
    expectedUserId: string | null,
    expectedBootstrapId: string | null,
  ): Promise<ChallengeRow | undefined> {
    return (await this.database.query<ChallengeRow>(`
      UPDATE admin_webauthn_challenge
      SET consumed_at = clock_timestamp()
      WHERE id = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > clock_timestamp()
        AND user_id IS NOT DISTINCT FROM $3::uuid
        AND bootstrap_id IS NOT DISTINCT FROM $4::uuid
      RETURNING id, user_id, bootstrap_id, challenge_hash
    `, [challengeId, purpose, expectedUserId, expectedBootstrapId])).rows[0];
  }

  async activeCredentials(userId: string): Promise<CredentialRow[]> {
    return (await this.database.query<CredentialRow>(`
      SELECT credential.id, credential.user_id, account.role, credential.credential_id,
        credential.public_key, credential.counter, credential.device_type, credential.backed_up,
        credential.transports, credential.aaguid, credential.name,
        credential.created_at, credential.last_used_at
      FROM admin_webauthn_credential AS credential
      JOIN user_account AS account ON account.user_id = credential.user_id
      WHERE credential.user_id = $1 AND credential.revoked_at IS NULL
        AND account.role IN ('admin', 'superadmin')
        AND account.deleted_at IS NULL AND account.is_banned = false
      ORDER BY credential.created_at, credential.id
    `, [userId])).rows;
  }

  async activeCredentialByExternalId(credentialId: string): Promise<CredentialRow | undefined> {
    return (await this.database.query<CredentialRow>(`
      SELECT credential.id, credential.user_id, account.role, credential.credential_id,
        credential.public_key, credential.counter, credential.device_type, credential.backed_up,
        credential.transports, credential.aaguid, credential.name,
        credential.created_at, credential.last_used_at
      FROM admin_webauthn_credential AS credential
      JOIN user_account AS account ON account.user_id = credential.user_id
      WHERE credential.credential_id = $1 AND credential.revoked_at IS NULL
        AND account.role IN ('admin', 'superadmin')
        AND account.deleted_at IS NULL AND account.is_banned = false
    `, [credentialId])).rows[0];
  }

  async completeBootstrapRegistration(input: {
    bootstrapId: string;
    secretHash: Buffer;
    credential: NewCredential;
    session: NewSession;
  }): Promise<ActiveSessionRow | undefined> {
    return this.database.transaction(async (client) => {
      const bootstrap = (await client.query<BootstrapRow>(`
        UPDATE admin_webauthn_bootstrap AS bootstrap
        SET consumed_at = clock_timestamp()
        FROM user_account AS account
        WHERE bootstrap.id = $1 AND bootstrap.secret_hash = $2
          AND bootstrap.user_id = account.user_id
          AND bootstrap.consumed_at IS NULL AND bootstrap.expires_at > clock_timestamp()
          AND account.role IN ('admin', 'superadmin')
          AND account.deleted_at IS NULL AND account.is_banned = false
        RETURNING bootstrap.id, bootstrap.user_id, account.role
      `, [input.bootstrapId, input.secretHash])).rows[0];
      if (!bootstrap) return undefined;
      const credentialId = await this.insertCredential(client, bootstrap.user_id, input.credential);
      const session = await this.insertSession(client, bootstrap.user_id, bootstrap.role, credentialId, input.session);
      await this.insertEvent(client, bootstrap.user_id, credentialId, session.id, 'bootstrap_registered');
      return session;
    });
  }

  async addCredential(userId: string, credential: NewCredential): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const account = (await client.query<{ role: AdminRole }>(`
        SELECT role FROM user_account
        WHERE user_id = $1 AND role IN ('admin', 'superadmin')
          AND deleted_at IS NULL AND is_banned = false
        FOR UPDATE
      `, [userId])).rows[0];
      if (!account) return false;
      const credentialId = await this.insertCredential(client, userId, credential);
      await this.insertEvent(client, userId, credentialId, null, 'credential_added');
      return true;
    });
  }

  async completeAuthentication(
    credential: CredentialRow,
    expectedCounter: number,
    nextCounter: number,
    deviceType: 'singleDevice' | 'multiDevice',
    backedUp: boolean,
    session: NewSession,
  ): Promise<ActiveSessionRow | undefined> {
    return this.database.transaction(async (client) => {
      const locked = (await client.query<{ counter: string; user_id: string; role: AdminRole }>(`
        SELECT credential.counter, credential.user_id, account.role
        FROM admin_webauthn_credential AS credential
        JOIN user_account AS account ON account.user_id = credential.user_id
        WHERE credential.id = $1 AND credential.revoked_at IS NULL
          AND account.role IN ('admin', 'superadmin')
          AND account.deleted_at IS NULL AND account.is_banned = false
        FOR UPDATE OF credential
      `, [credential.id])).rows[0];
      if (!locked || Number(locked.counter) !== expectedCounter) return undefined;
      await client.query(`
        UPDATE admin_webauthn_credential
        SET counter = $2, device_type = $3, backed_up = $4, last_used_at = clock_timestamp()
        WHERE id = $1
      `, [credential.id, nextCounter, deviceType, backedUp]);
      const created = await this.insertSession(client, locked.user_id, locked.role, credential.id, session);
      await this.insertEvent(client, locked.user_id, credential.id, created.id, 'login_succeeded');
      return created;
    });
  }

  async activeSession(tokenHash: Buffer, idleTtlMillis: number): Promise<ActiveSessionRow | undefined> {
    return (await this.database.query<ActiveSessionRow>(`
      UPDATE admin_session AS session
      SET last_seen_at = clock_timestamp(),
        idle_expires_at = LEAST(
          session.absolute_expires_at,
          clock_timestamp() + ($2::bigint * INTERVAL '1 millisecond')
        )
      FROM user_account AS account, admin_webauthn_credential AS credential
      WHERE session.token_hash = $1 AND session.user_id = account.user_id
        AND session.credential_id = credential.id
        AND credential.user_id = session.user_id AND credential.revoked_at IS NULL
        AND session.revoked_at IS NULL
        AND session.idle_expires_at > clock_timestamp()
        AND session.absolute_expires_at > clock_timestamp()
        AND account.role IN ('admin', 'superadmin')
        AND account.deleted_at IS NULL AND account.is_banned = false
      RETURNING session.id, session.user_id, session.credential_id, account.role, session.authenticated_at,
        LEAST(session.idle_expires_at, session.absolute_expires_at) AS expires_at
    `, [tokenHash, idleTtlMillis])).rows[0];
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    await this.database.transaction(async (client) => {
      const revoked = (await client.query<{ id: string }>(`
        UPDATE admin_session SET revoked_at = COALESCE(revoked_at, clock_timestamp())
        WHERE id = $1 AND user_id = $2 RETURNING id
      `, [sessionId, userId])).rows[0];
      if (revoked) await this.insertEvent(client, userId, null, sessionId, 'logout');
    });
  }

  async revokeOtherSessions(userId: string, currentSessionId: string): Promise<number> {
    return this.database.transaction(async (client) => {
      const result = await client.query(`
        UPDATE admin_session SET revoked_at = clock_timestamp()
        WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL
      `, [userId, currentSessionId]);
      await this.insertEvent(client, userId, null, currentSessionId, 'other_sessions_revoked');
      return result.rowCount ?? 0;
    });
  }

  async revokeCredential(
    userId: string,
    credentialId: string,
    currentSessionId: string,
  ): Promise<CredentialRevocationResult> {
    return this.database.transaction(async (client) => {
      const credentials = (await client.query<{ id: string }>(`
        SELECT id FROM admin_webauthn_credential
        WHERE user_id = $1 AND revoked_at IS NULL
        ORDER BY id FOR UPDATE
      `, [userId])).rows;
      if (!credentials.some((item) => item.id === credentialId)) return 'not_found';
      if (credentials.length <= 1) return 'last_credential';
      await client.query(`UPDATE admin_webauthn_credential SET revoked_at = clock_timestamp() WHERE id = $1`, [credentialId]);
      await client.query(`
        UPDATE admin_session SET revoked_at = clock_timestamp()
        WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL
      `, [userId, currentSessionId]);
      await this.insertEvent(client, userId, credentialId, currentSessionId, 'credential_revoked');
      return 'revoked';
    });
  }

  private async insertCredential(client: PoolClient, userId: string, credential: NewCredential): Promise<string> {
    const result = await client.query<{ id: string }>(`
      INSERT INTO admin_webauthn_credential (
        user_id, credential_id, public_key, counter, device_type, backed_up, transports, aaguid, name
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `, [
      userId, credential.credentialId, credential.publicKey, credential.counter,
      credential.deviceType, credential.backedUp, credential.transports,
      credential.aaguid, credential.name,
    ]);
    return result.rows[0]!.id;
  }

  private async insertSession(
    client: PoolClient,
    userId: string,
    role: AdminRole,
    credentialId: string,
    session: NewSession,
  ): Promise<ActiveSessionRow> {
    const result = await client.query<ActiveSessionRow>(`
      INSERT INTO admin_session (user_id, credential_id, token_hash, idle_expires_at, absolute_expires_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, user_id, credential_id, $6::text AS role, authenticated_at,
        LEAST(idle_expires_at, absolute_expires_at) AS expires_at
    `, [userId, credentialId, session.tokenHash, session.idleExpiresAt, session.absoluteExpiresAt, role]);
    return result.rows[0]!;
  }

  private async insertEvent(
    client: PoolClient,
    userId: string,
    credentialId: string | null,
    sessionId: string | null,
    eventType: AdminAuthEventType,
  ): Promise<void> {
    await client.query(`
      INSERT INTO admin_auth_event (user_id, credential_id, session_id, event_type)
      VALUES ($1, $2, $3, $4)
    `, [userId, credentialId, sessionId, eventType]);
  }
}
