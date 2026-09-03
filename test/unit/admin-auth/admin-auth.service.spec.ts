import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { AdminAuthService } from '../../../src/admin-auth/admin-auth.service';

jest.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: jest.fn(),
  generateRegistrationOptions: jest.fn(),
  verifyAuthenticationResponse: jest.fn(),
  verifyRegistrationResponse: jest.fn(),
}));

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CHALLENGE_ID = '22222222-2222-4222-8222-222222222222';
const CREDENTIAL_UUID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';

describe('AdminAuthService', () => {
  const config = {
    adminAuth: {
      rpId: 'localhost',
      origin: 'http://localhost:5173',
      rpName: 'Histae Administration',
      challengeTtlMillis: 300_000,
      bootstrapTtlMillis: 900_000,
      sessionIdleTtlMillis: 1_800_000,
      sessionAbsoluteTtlMillis: 28_800_000,
      recentAuthenticationMillis: 600_000,
    },
  };

  beforeEach(() => jest.clearAllMocks());

  it('stores only a challenge digest for username-less authentication', async () => {
    jest.mocked(generateAuthenticationOptions).mockResolvedValue({ challenge: 'challenge-value' } as never);
    const repository = { createChallenge: jest.fn().mockResolvedValue(CHALLENGE_ID) };
    const service = new AdminAuthService(repository as never, config as never);

    await expect(service.authenticationOptions()).resolves.toEqual({
      challenge_id: CHALLENGE_ID,
      options: { challenge: 'challenge-value' },
    });
    expect(repository.createChallenge).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'authentication',
      challengeHash: expect.any(Buffer),
    }));
    expect(repository.createChallenge.mock.calls[0]?.[0].challengeHash.toString('utf8')).not.toContain('challenge-value');
  });

  it('verifies a discoverable credential and creates a short hashed session', async () => {
    const challengeHash = Buffer.alloc(32, 1);
    const stored = {
      id: CREDENTIAL_UUID,
      user_id: USER_ID,
      role: 'admin',
      credential_id: 'credential-id',
      public_key: Buffer.from('public-key'),
      counter: '2',
      device_type: 'singleDevice',
      backed_up: false,
      transports: ['usb'],
    };
    const repository = {
      consumeChallenge: jest.fn().mockResolvedValue({ challenge_hash: challengeHash }),
      activeCredentialByExternalId: jest.fn().mockResolvedValue(stored),
      completeAuthentication: jest.fn().mockResolvedValue({
        id: SESSION_ID,
        user_id: USER_ID,
        credential_id: CREDENTIAL_UUID,
        role: 'admin',
        authenticated_at: new Date('2030-01-01T00:00:00Z'),
        expires_at: new Date('2030-01-01T00:30:00Z'),
      }),
    };
    jest.mocked(verifyAuthenticationResponse).mockResolvedValue({
      verified: true,
      authenticationInfo: {
        credentialID: 'credential-id', newCounter: 3, userVerified: true,
        credentialDeviceType: 'singleDevice', credentialBackedUp: false,
        origin: 'http://localhost:5173', rpID: 'localhost',
      },
    });
    const service = new AdminAuthService(repository as never, config as never);

    const result = await service.authenticate({ challengeId: CHALLENGE_ID, credential: authenticationPayload() });

    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.session).toEqual(expect.objectContaining({ user_id: USER_ID, role: 'admin' }));
    expect(repository.completeAuthentication).toHaveBeenCalledWith(
      stored, 2, 3, 'singleDevice', false,
      expect.objectContaining({ tokenHash: expect.any(Buffer) }),
    );
    expect(verifyAuthenticationResponse).toHaveBeenCalledWith(expect.objectContaining({
      expectedOrigin: 'http://localhost:5173', expectedRPID: 'localhost', requireUserVerification: true,
    }));
  });

  it('fails closed for an expired authentication challenge', async () => {
    const repository = { consumeChallenge: jest.fn().mockResolvedValue(undefined) };
    const service = new AdminAuthService(repository as never, config as never);
    await expect(service.authenticate({ challengeId: CHALLENGE_ID, credential: authenticationPayload() }))
      .rejects.toEqual(expect.objectContaining({ status: 401, code: 'webauthn_authentication_failed' }));
  });

  it('registers a user-verified additional credential', async () => {
    const challengeHash = Buffer.alloc(32, 2);
    const repository = {
      activeCredentials: jest.fn().mockResolvedValue([]),
      createChallenge: jest.fn().mockResolvedValue(CHALLENGE_ID),
      consumeChallenge: jest.fn().mockResolvedValue({ challenge_hash: challengeHash }),
      addCredential: jest.fn().mockResolvedValue(true),
    };
    jest.mocked(generateRegistrationOptions).mockResolvedValue({ challenge: 'registration-challenge' } as never);
    jest.mocked(verifyRegistrationResponse).mockResolvedValue({
      verified: true,
      registrationInfo: {
        fmt: 'none', aaguid: '00000000-0000-0000-0000-000000000000',
        credential: { id: 'credential-id', publicKey: new Uint8Array([1, 2]), counter: 0, transports: ['internal'] },
        credentialType: 'public-key', attestationObject: new Uint8Array(), userVerified: true,
        credentialDeviceType: 'multiDevice', credentialBackedUp: true,
        origin: 'http://localhost:5173', rpID: 'localhost',
      },
    });
    const service = new AdminAuthService(repository as never, config as never);

    await service.addCredential({
      userId: USER_ID,
      challengeId: CHALLENGE_ID,
      credential: registrationPayload(),
      name: '  Clé principale  ',
    });

    expect(repository.addCredential).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      credentialId: 'credential-id', name: 'Clé principale', backedUp: true,
    }));
  });

  it('maps every credential revocation outcome without exception-driven repository control flow', async () => {
    const repository = { revokeCredential: jest.fn() };
    const service = new AdminAuthService(repository as never, config as never);

    await expect(service.revokeCredential(USER_ID, CREDENTIAL_UUID, SESSION_ID, CREDENTIAL_UUID))
      .rejects.toEqual(expect.objectContaining({ status: 409, code: 'current_admin_credential' }));
    expect(repository.revokeCredential).not.toHaveBeenCalled();

    repository.revokeCredential.mockResolvedValueOnce('not_found');
    await expect(service.revokeCredential(USER_ID, CHALLENGE_ID, SESSION_ID, CREDENTIAL_UUID))
      .rejects.toEqual(expect.objectContaining({ status: 404, code: 'admin_credential_not_found' }));

    repository.revokeCredential.mockResolvedValueOnce('last_credential');
    await expect(service.revokeCredential(USER_ID, CHALLENGE_ID, SESSION_ID, CREDENTIAL_UUID))
      .rejects.toEqual(expect.objectContaining({ status: 409, code: 'last_admin_credential' }));

    repository.revokeCredential.mockResolvedValueOnce('revoked');
    await expect(service.revokeCredential(USER_ID, CHALLENGE_ID, SESSION_ID, CREDENTIAL_UUID))
      .resolves.toBeUndefined();
  });

  it('lists active sessions without token material and marks the current one', async () => {
    const repository = { activeSessions: jest.fn().mockResolvedValue([{
      id: SESSION_ID,
      credential_id: CREDENTIAL_UUID,
      credential_name: 'Clé principale',
      authenticated_at: new Date('2030-01-01T00:00:00.000Z'),
      last_seen_at: new Date('2030-01-01T00:05:00.000Z'),
      expires_at: new Date('2030-01-01T00:30:00.000Z'),
      token_hash: Buffer.from('must-not-leak'),
    }]) };
    const service = new AdminAuthService(repository as never, config as never);

    const result = await service.sessions(USER_ID, SESSION_ID);
    expect(result).toEqual([expect.objectContaining({ id: SESSION_ID, current: true, credential_name: 'Clé principale' })]);
    expect(result[0]).not.toHaveProperty('token_hash');
  });

  it('renames a credential and revokes a selected non-current session', async () => {
    const repository = {
      renameCredential: jest.fn().mockResolvedValue(true),
      revokeSelectedSession: jest.fn().mockResolvedValue(true),
    };
    const service = new AdminAuthService(repository as never, config as never);

    await expect(service.renameCredential(USER_ID, CREDENTIAL_UUID, SESSION_ID, '  Portable  '))
      .resolves.toBeUndefined();
    expect(repository.renameCredential).toHaveBeenCalledWith(USER_ID, CREDENTIAL_UUID, SESSION_ID, 'Portable');
    await expect(service.revokeSelectedSession(USER_ID, CHALLENGE_ID, SESSION_ID)).resolves.toBeUndefined();
    expect(repository.revokeSelectedSession).toHaveBeenCalledWith(USER_ID, CHALLENGE_ID, SESSION_ID);
  });

  it('never lets the selected-session route revoke the current session', async () => {
    const repository = { revokeSelectedSession: jest.fn() };
    const service = new AdminAuthService(repository as never, config as never);
    await expect(service.revokeSelectedSession(USER_ID, SESSION_ID, SESSION_ID))
      .rejects.toEqual(expect.objectContaining({ status: 409, code: 'current_admin_session' }));
    expect(repository.revokeSelectedSession).not.toHaveBeenCalled();
  });

  it('returns bounded authentication history with cursor pagination', async () => {
    const repository = { authEvents: jest.fn().mockResolvedValue([{
      id: CHALLENGE_ID,
      event_type: 'login_succeeded',
      credential_id: CREDENTIAL_UUID,
      session_id: SESSION_ID,
      created_at: new Date('2030-01-01T00:00:00.000Z'),
    }]) };
    const service = new AdminAuthService(repository as never, config as never);

    await expect(service.authEvents(USER_ID, 20)).resolves.toEqual({
      items: [expect.objectContaining({ id: CHALLENGE_ID, event_type: 'login_succeeded' })],
      next_cursor: null,
    });
    expect(repository.authEvents).toHaveBeenCalledWith(USER_ID, 21, undefined);
  });
});

function authenticationPayload(): Record<string, unknown> {
  return {
    id: 'credential-id', rawId: 'credential-id', type: 'public-key',
    response: { clientDataJSON: 'Y2xpZW50', authenticatorData: 'YXV0aA', signature: 'c2ln' },
    clientExtensionResults: {}, authenticatorAttachment: 'cross-platform',
  };
}

function registrationPayload(): Record<string, unknown> {
  return {
    id: 'credential-id', rawId: 'credential-id', type: 'public-key',
    response: { clientDataJSON: 'Y2xpZW50', attestationObject: 'YXR0ZXN0YXRpb24', transports: ['internal'] },
    clientExtensionResults: {}, authenticatorAttachment: 'platform',
  };
}
