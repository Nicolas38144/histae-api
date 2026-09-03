import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type Base64URLString,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { ApiError, apiError } from '../common/api-error';
import { normalizePrintableText } from '../common/normalize-printable-text';
import { cursorPage, decodeCursor, type CursorPage } from '../common/pagination';
import { ConfigService } from '../config/config.service';
import {
  AdminAuthRepository,
  type ActiveSessionRow,
  type CredentialRow,
  type NewCredential,
  type NewSession,
} from './admin-auth.repository';
import type {
  AdminAuthEvent,
  AdminAuthSession,
  AdminCredential,
  AdminSessionSummary,
  AuthenticationOptions,
  RegistrationOptions,
  SessionCreation,
} from './admin-auth.models';
import { authenticationCredential, registrationCredential } from './webauthn-payload';

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly repository: AdminAuthRepository,
    private readonly config: ConfigService,
  ) {}

  async bootstrapRegistrationOptions(token: string): Promise<RegistrationOptions> {
    const parsed = parseBootstrapToken(token);
    const bootstrap = await this.repository.bootstrap(parsed.id, digest(parsed.secret));
    if (!bootstrap) invalidBootstrap();
    return this.registrationOptions(bootstrap.user_id, bootstrap.id);
  }

  async completeBootstrapRegistration(input: {
    token: string;
    challengeId: string;
    credential: Record<string, unknown>;
    name: string;
  }): Promise<SessionCreation> {
    const parsedToken = parseBootstrapToken(input.token);
    const tokenHash = digest(parsedToken.secret);
    const bootstrap = await this.repository.bootstrap(parsedToken.id, tokenHash);
    if (!bootstrap) invalidBootstrap();
    const challenge = await this.repository.consumeChallenge(
      input.challengeId,
      'bootstrap_registration',
      bootstrap.user_id,
      bootstrap.id,
    );
    if (!challenge) invalidChallenge();
    const verified = await this.verifyRegistration(registrationCredential(input.credential), challenge.challenge_hash);
    const sessionSecrets = this.newSession();
    try {
      const completed = await this.repository.completeBootstrapRegistration({
        bootstrapId: bootstrap.id,
        secretHash: tokenHash,
        credential: this.newCredential(verified, input.name),
        session: sessionSecrets.persisted,
      });
      if (!completed) invalidBootstrap();
      return { token: sessionSecrets.token, session: sessionView(completed) };
    } catch (error) {
      this.translateCredentialConflict(error);
    }
  }

  async authenticationOptions(): Promise<AuthenticationOptions> {
    const options = await generateAuthenticationOptions({
      rpID: this.config.adminAuth.rpId,
      timeout: this.config.adminAuth.challengeTtlMillis,
      userVerification: 'required',
    });
    const challengeId = await this.repository.createChallenge({
      purpose: 'authentication',
      challengeHash: digest(options.challenge),
      expiresAt: new Date(Date.now() + this.config.adminAuth.challengeTtlMillis),
    });
    return { challenge_id: challengeId, options };
  }

  async authenticate(input: {
    challengeId: string;
    credential: Record<string, unknown>;
  }): Promise<SessionCreation> {
    const credential = authenticationCredential(input.credential);
    const challenge = await this.repository.consumeChallenge(input.challengeId, 'authentication', null, null);
    if (!challenge) invalidAuthentication();
    const stored = await this.repository.activeCredentialByExternalId(credential.id);
    if (!stored) invalidAuthentication();
    const verification = await this.verifyAuthentication(credential, stored, challenge.challenge_hash);
    const sessionSecrets = this.newSession();
    const created = await this.repository.completeAuthentication(
      stored,
      Number(stored.counter),
      verification.newCounter,
      verification.credentialDeviceType,
      verification.credentialBackedUp,
      sessionSecrets.persisted,
    );
    if (!created) invalidAuthentication();
    return { token: sessionSecrets.token, session: sessionView(created) };
  }

  async additionalRegistrationOptions(userId: string): Promise<RegistrationOptions> {
    return this.registrationOptions(userId, null);
  }

  async addCredential(input: {
    userId: string;
    challengeId: string;
    credential: Record<string, unknown>;
    name: string;
  }): Promise<void> {
    const challenge = await this.repository.consumeChallenge(
      input.challengeId,
      'additional_registration',
      input.userId,
      null,
    );
    if (!challenge) invalidChallenge();
    const verified = await this.verifyRegistration(registrationCredential(input.credential), challenge.challenge_hash);
    try {
      if (!await this.repository.addCredential(input.userId, this.newCredential(verified, input.name))) {
        throw apiError(401, 'admin_session_invalid', 'The administrator session is invalid or expired.');
      }
    } catch (error) {
      this.translateCredentialConflict(error);
    }
  }

  async authenticateSession(token: string): Promise<ActiveSessionRow | undefined> {
    return this.repository.activeSession(digest(token), this.config.adminAuth.sessionIdleTtlMillis);
  }

  async credentials(userId: string, currentCredentialId: string): Promise<AdminCredential[]> {
    return (await this.repository.activeCredentials(userId)).map((credential) => ({
      id: credential.id,
      name: credential.name,
      device_type: credential.device_type,
      backed_up: credential.backed_up,
      transports: credential.transports,
      created_at: credential.created_at.toISOString(),
      last_used_at: credential.last_used_at?.toISOString() ?? null,
      current: credential.id === currentCredentialId,
    }));
  }

  async sessions(userId: string, currentSessionId: string): Promise<AdminSessionSummary[]> {
    return (await this.repository.activeSessions(userId)).map((session) => ({
      id: session.id,
      credential_id: session.credential_id,
      credential_name: session.credential_name,
      authenticated_at: session.authenticated_at.toISOString(),
      last_seen_at: session.last_seen_at.toISOString(),
      expires_at: session.expires_at.toISOString(),
      current: session.id === currentSessionId,
    }));
  }

  async revokeSelectedSession(userId: string, targetSessionId: string, currentSessionId: string): Promise<void> {
    if (targetSessionId === currentSessionId) {
      throw apiError(409, 'current_admin_session', 'The current administrator session cannot be revoked here.');
    }
    if (!await this.repository.revokeSelectedSession(userId, targetSessionId, currentSessionId)) {
      throw apiError(404, 'admin_session_not_found', 'The administrator session was not found.');
    }
  }

  async renameCredential(
    userId: string,
    credentialId: string,
    currentSessionId: string,
    inputName: string,
  ): Promise<void> {
    if (!await this.repository.renameCredential(userId, credentialId, currentSessionId, normalizedName(inputName))) {
      throw apiError(404, 'admin_credential_not_found', 'The administrator credential was not found.');
    }
  }

  async authEvents(userId: string, limit: number, rawCursor?: string): Promise<CursorPage<AdminAuthEvent>> {
    if (limit < 1 || limit > 100) invalidAuthHistoryRequest();
    const rows = await this.repository.authEvents(userId, limit + 1, decodeCursor(rawCursor));
    const page = cursorPage(rows, limit, (row) => row.created_at);
    return {
      items: page.items.map((event) => ({
        id: event.id,
        event_type: event.event_type,
        credential_id: event.credential_id,
        session_id: event.session_id,
        created_at: event.created_at.toISOString(),
      })),
      next_cursor: page.next_cursor,
    };
  }

  async revokeCredential(
    userId: string,
    credentialId: string,
    currentSessionId: string,
    currentCredentialId: string,
  ): Promise<void> {
    if (credentialId === currentCredentialId) {
      throw apiError(409, 'current_admin_credential', 'Sign in with another credential before revoking this one.');
    }
    const result = await this.repository.revokeCredential(userId, credentialId, currentSessionId);
    switch (result) {
      case 'revoked':
        return;
      case 'not_found':
        throw apiError(404, 'admin_credential_not_found', 'The administrator credential was not found.');
      case 'last_credential':
        throw apiError(409, 'last_admin_credential', 'The last active administrator credential cannot be revoked.');
    }
  }

  revokeOtherSessions(userId: string, currentSessionId: string): Promise<number> {
    return this.repository.revokeOtherSessions(userId, currentSessionId);
  }

  revokeSession(userId: string, sessionId: string): Promise<void> {
    return this.repository.revokeSession(userId, sessionId);
  }

  private async registrationOptions(userId: string, bootstrapId: string | null): Promise<RegistrationOptions> {
    const credentials = await this.repository.activeCredentials(userId);
    const options = await generateRegistrationOptions({
      rpName: this.config.adminAuth.rpName,
      rpID: this.config.adminAuth.rpId,
      userID: uuidBytes(userId),
      userName: `admin:${userId}`,
      userDisplayName: 'Histae administrator',
      timeout: this.config.adminAuth.challengeTtlMillis,
      attestationType: 'none',
      excludeCredentials: credentials.map((credential) => ({
        id: credential.credential_id as Base64URLString,
        transports: credential.transports,
      })),
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
    });
    const challengeId = await this.repository.createChallenge({
      purpose: bootstrapId ? 'bootstrap_registration' : 'additional_registration',
      challengeHash: digest(options.challenge),
      userId,
      ...(bootstrapId ? { bootstrapId } : {}),
      expiresAt: new Date(Date.now() + this.config.adminAuth.challengeTtlMillis),
    });
    return { challenge_id: challengeId, options };
  }

  private async verifyRegistration(response: RegistrationResponseJSON, challengeHash: Buffer) {
    try {
      const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: (candidate) => equalDigest(candidate, challengeHash),
        expectedOrigin: this.config.adminAuth.origin,
        expectedRPID: this.config.adminAuth.rpId,
        requireUserPresence: true,
        requireUserVerification: true,
      });
      if (!verification.verified || !verification.registrationInfo.userVerified) invalidRegistration();
      return verification.registrationInfo;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw apiError(401, 'webauthn_registration_failed', 'The WebAuthn registration could not be verified.');
    }
  }

  private async verifyAuthentication(
    response: AuthenticationResponseJSON,
    stored: CredentialRow,
    challengeHash: Buffer,
  ) {
    try {
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: (candidate) => equalDigest(candidate, challengeHash),
        expectedOrigin: this.config.adminAuth.origin,
        expectedRPID: this.config.adminAuth.rpId,
        requireUserVerification: true,
        credential: {
          id: stored.credential_id as Base64URLString,
          publicKey: new Uint8Array(stored.public_key),
          counter: Number(stored.counter),
          transports: stored.transports,
        },
      });
      if (!verification.verified || !verification.authenticationInfo.userVerified) invalidAuthentication();
      return verification.authenticationInfo;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      invalidAuthentication();
    }
  }

  private newCredential(
    registration: Awaited<ReturnType<typeof verifyRegistrationResponse>>['registrationInfo'],
    inputName: string,
  ): NewCredential {
    if (!registration) invalidRegistration();
    const name = normalizedName(inputName);
    return {
      credentialId: registration.credential.id,
      publicKey: Buffer.from(registration.credential.publicKey),
      counter: registration.credential.counter,
      deviceType: registration.credentialDeviceType,
      backedUp: registration.credentialBackedUp,
      transports: normalizedTransports(registration.credential.transports ?? []),
      aaguid: registration.aaguid || null,
      name,
    };
  }

  private newSession(): { token: string; persisted: NewSession } {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    return {
      token,
      persisted: {
        tokenHash: digest(token),
        idleExpiresAt: new Date(now + this.config.adminAuth.sessionIdleTtlMillis),
        absoluteExpiresAt: new Date(now + this.config.adminAuth.sessionAbsoluteTtlMillis),
      },
    };
  }

  private translateCredentialConflict(error: unknown): never {
    if (isPostgresUniqueViolation(error)) {
      throw apiError(409, 'webauthn_credential_already_registered', 'This WebAuthn credential is already registered.');
    }
    throw error;
  }
}

function parseBootstrapToken(token: string): { id: string; secret: string } {
  const [id, secret, extra] = token.split(':');
  if (extra !== undefined || !id || !secret) invalidBootstrap();
  return { id, secret };
}

function normalizedName(value: string): string {
  const normalized = normalizePrintableText(value, { minLength: 1, maxLength: 100, maxBytes: 200 });
  if (!normalized) {
    throw apiError(400, 'invalid_admin_credential_name', 'The administrator credential name is invalid.');
  }
  return normalized;
}

function normalizedTransports(values: string[]): string[] {
  const allowed = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);
  return [...new Set(values.filter((value) => allowed.has(value)))];
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function equalDigest(candidate: string, expected: Buffer): boolean {
  return timingSafeEqual(digest(candidate), expected);
}

function uuidBytes(uuid: string): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(new ArrayBuffer(16));
  result.set(Buffer.from(uuid.replaceAll('-', ''), 'hex'));
  return result;
}

function sessionView(row: ActiveSessionRow): AdminAuthSession {
  return {
    user_id: row.user_id,
    role: row.role,
    authenticated_at: row.authenticated_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
  };
}

function isPostgresUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function invalidBootstrap(): never {
  throw apiError(401, 'invalid_or_expired_admin_bootstrap', 'The administrator enrollment token is invalid or expired.');
}

function invalidChallenge(): never {
  throw apiError(401, 'invalid_or_expired_webauthn_challenge', 'The WebAuthn challenge is invalid or expired.');
}

function invalidRegistration(): never {
  throw apiError(401, 'webauthn_registration_failed', 'The WebAuthn registration could not be verified.');
}

function invalidAuthentication(): never {
  throw apiError(401, 'webauthn_authentication_failed', 'The WebAuthn authentication could not be verified.');
}

function invalidAuthHistoryRequest(): never {
  throw apiError(400, 'invalid_admin_auth_request', 'The administrator authentication request is invalid.');
}
