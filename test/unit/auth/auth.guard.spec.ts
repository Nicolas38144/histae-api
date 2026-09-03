import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AuthController } from '../../../src/auth/auth.controller';
import { JwtActiveGuard } from '../../../src/auth/auth.guard';
import { ALLOW_INCOMPLETE_ONBOARDING_KEY } from '../../../src/auth/onboarding.decorator';
import { UsersController } from '../../../src/users/users.controller';

const userId = 'cb4d3fc8-b0f4-4a87-a8dd-dac942b26da1';
const sessionId = '11111111-1111-4111-8111-111111111111';
const keyConfig = { verificationKeys: new Map([['primary', 'test-only-signing-key-for-mobile-sessions']]) };
const jwtMock = () => ({
  decode: jest.fn().mockReturnValue({ header: { alg: 'HS256', kid: 'primary' } }),
  verifyAsync: jest.fn().mockResolvedValue({ sub: userId, typ: 'access', sid: sessionId, exp: 2_000_000_000 }),
});
const legal = {
  termsVersion: 'terms-v1',
  privacyVersion: 'privacy-v1',
  sensitiveDataConsentVersion: 'sensitive-v1',
  locationConsentVersion: 'location-v1',
};

function context(request: { headers: { authorization: string }; auth?: unknown }): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => context,
    getClass: () => JwtActiveGuard,
  } as never;
}

describe('JwtActiveGuard legal onboarding enforcement', () => {
  it('rejects a signed JWT that is not explicitly typed as an access token', async () => {
    const request = { headers: { authorization: 'Bearer wrong-token-type' } };
    const database = { query: jest.fn() };
    const jwt = jwtMock();
    jwt.verifyAsync.mockResolvedValue({ sub: userId, typ: 'refresh' });
    const guard = new JwtActiveGuard(
      jwt as never,
      database as never,
      { legal, jwt: keyConfig } as never,
      { getAllAndOverride: jest.fn() } as never,
    );

    await expect(guard.canActivate(context(request))).rejects.toEqual(expect.objectContaining({
      status: 401,
      code: 'invalid_or_expired_access_token',
    }));
    expect(jwt.verifyAsync).toHaveBeenCalledWith('wrong-token-type', expect.objectContaining({
      algorithms: ['HS256'], audience: 'histae-app', issuer: 'histae-api',
    }));
    expect(database.query).not.toHaveBeenCalled();
  });

  it('blocks an active user whose legal onboarding is incomplete', async () => {
    const request = { headers: { authorization: 'Bearer access-token' } };
    const database = { query: jest.fn().mockResolvedValue({ rows: [{
      user_id: userId, role: 'user', is_banned: false, onboarding_complete: false,
    }] }) };
    const guard = new JwtActiveGuard(
      jwtMock() as never,
      database as never,
      { legal, jwt: keyConfig } as never,
      { getAllAndOverride: jest.fn().mockReturnValue(false) } as never,
    );

    await expect(guard.canActivate(context(request))).rejects.toEqual(expect.objectContaining({
      status: 403,
      code: 'onboarding_incomplete',
    }));
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining('privacy_notice_acknowledgement'), [
      userId, 'terms-v1', 'privacy-v1', sessionId,
    ]);
  });

  it('allows every protected route after current terms and privacy acknowledgement', async () => {
    const request: { headers: { authorization: string }; auth?: unknown } = {
      headers: { authorization: 'Bearer access-token' },
    };
    const guard = new JwtActiveGuard(
      jwtMock() as never,
      { query: jest.fn().mockResolvedValue({ rows: [{
        user_id: userId, role: 'user', is_banned: false, onboarding_complete: true,
      }] }) } as never,
      { legal, jwt: keyConfig } as never,
      { getAllAndOverride: jest.fn().mockReturnValue(false) } as never,
    );

    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(request.auth).toEqual(expect.objectContaining({ userId }));
  });

  it('keeps consent management, logout and account deletion accessible during onboarding', async () => {
    const request = { headers: { authorization: 'Bearer access-token' } };
    const guard = new JwtActiveGuard(
      jwtMock() as never,
      { query: jest.fn().mockResolvedValue({ rows: [{
        user_id: userId, role: 'user', is_banned: false, onboarding_complete: false,
      }] }) } as never,
      { legal, jwt: keyConfig } as never,
      { getAllAndOverride: jest.fn().mockReturnValue(true) } as never,
    );

    await expect(guard.canActivate(context(request))).resolves.toBe(true);
  });

  it('marks only the necessary authenticated endpoints as onboarding exceptions', () => {
    const reflector = new Reflector();
    expect(reflector.get(ALLOW_INCOMPLETE_ONBOARDING_KEY, UsersController.prototype.getConsents)).toBe(true);
    expect(reflector.get(ALLOW_INCOMPLETE_ONBOARDING_KEY, UsersController.prototype.updateConsents)).toBe(true);
    expect(reflector.get(ALLOW_INCOMPLETE_ONBOARDING_KEY, UsersController.prototype.deleteAccount)).toBe(true);
    expect(reflector.get(ALLOW_INCOMPLETE_ONBOARDING_KEY, AuthController.prototype.logout)).toBe(true);
    expect(reflector.get(ALLOW_INCOMPLETE_ONBOARDING_KEY, UsersController.prototype.updateProfile)).toBeUndefined();
  });
});

describe('JwtActiveGuard signing keys and session binding', () => {
  const activeKey = 'active-test-key-of-at-least-thirty-two-bytes';
  const oldKey = 'previous-test-key-of-at-least-thirty-two-bytes';
  const jwt = new JwtService();
  const config = { legal, jwt: { verificationKeys: new Map([['active', activeKey], ['old', oldKey]]) } };
  const valid = { sub: userId, sid: sessionId, typ: 'access' };

  function verify(token: string, rows = [{ user_id: userId, role: 'user', is_banned: false, onboarding_complete: true }]) {
    const database = { query: jest.fn().mockResolvedValue({ rows }) };
    const guard = new JwtActiveGuard(jwt, database as never, config as never, { getAllAndOverride: () => false } as never);
    return { result: guard.canActivate(context({ headers: { authorization: `Bearer ${token}` } })), database };
  }
  const sign = (payload: object, kid: string, secret = activeKey) => jwt.signAsync(payload, {
    secret, keyid: kid, algorithm: 'HS256', audience: 'histae-app', issuer: 'histae-api', expiresIn: 60,
  });

  it('accepts an explicitly configured previous signing key', async () => {
    await expect(verify(await sign(valid, 'old', oldKey)).result).resolves.toBe(true);
  });
  it('rejects a correct signature carrying an unknown key ID before reading the account', async () => {
    const { result, database } = verify(await sign(valid, 'unknown'));
    await expect(result).rejects.toMatchObject({ status: 401, code: 'invalid_or_expired_access_token' });
    expect(database.query).not.toHaveBeenCalled();
  });
  it('rejects missing session binding and algorithm confusion', async () => {
    await expect(verify(await sign({ sub: userId, typ: 'access' }, 'active')).result).rejects.toMatchObject({ status: 401 });
    const wrongAlgorithm = await jwt.signAsync(valid, { secret: activeKey, keyid: 'active', algorithm: 'HS384', expiresIn: 60 });
    await expect(verify(wrongAlgorithm).result).rejects.toMatchObject({ status: 401 });
  });
  it('requires expiration even on a correctly signed JWT', async () => {
    const token = await jwt.signAsync(valid, { secret: activeKey, keyid: 'active', algorithm: 'HS256', audience: 'histae-app', issuer: 'histae-api' });
    await expect(verify(token).result).rejects.toMatchObject({ status: 401 });
  });
  it('rejects a revoked or foreign session even with a valid signature', async () => {
    const { result, database } = verify(await sign(valid, 'active'), []);
    await expect(result).rejects.toMatchObject({ status: 401 });
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining('session.user_id = account.user_id'), [userId, 'terms-v1', 'privacy-v1', sessionId]);
  });
  it('rejects a retired key as soon as it leaves the configured ring', async () => {
    const token = await sign(valid, 'retired', oldKey);
    await expect(verify(token).result).rejects.toMatchObject({ status: 401 });
  });
});
