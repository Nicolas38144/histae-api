import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthController } from '../../../src/auth/auth.controller';
import { JwtActiveGuard } from '../../../src/auth/auth.guard';
import { ALLOW_INCOMPLETE_ONBOARDING_KEY } from '../../../src/auth/onboarding.decorator';
import { UsersController } from '../../../src/users/users.controller';

const userId = 'cb4d3fc8-b0f4-4a87-a8dd-dac942b26da1';
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
  it('blocks an active user whose legal onboarding is incomplete', async () => {
    const request = { headers: { authorization: 'Bearer access-token' } };
    const database = { query: jest.fn().mockResolvedValue({ rows: [{
      user_id: userId, role: 'user', is_banned: false, onboarding_complete: false,
    }] }) };
    const guard = new JwtActiveGuard(
      { verifyAsync: jest.fn().mockResolvedValue({ sub: userId }) } as never,
      database as never,
      { legal } as never,
      { getAllAndOverride: jest.fn().mockReturnValue(false) } as never,
    );

    await expect(guard.canActivate(context(request))).rejects.toEqual(expect.objectContaining({
      status: 403,
      code: 'onboarding_incomplete',
    }));
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining('privacy_notice_acknowledgement'), [
      userId, 'terms-v1', 'privacy-v1',
    ]);
  });

  it('allows every protected route after current terms and privacy acknowledgement', async () => {
    const request: { headers: { authorization: string }; auth?: unknown } = {
      headers: { authorization: 'Bearer access-token' },
    };
    const guard = new JwtActiveGuard(
      { verifyAsync: jest.fn().mockResolvedValue({ sub: userId }) } as never,
      { query: jest.fn().mockResolvedValue({ rows: [{
        user_id: userId, role: 'user', is_banned: false, onboarding_complete: true,
      }] }) } as never,
      { legal } as never,
      { getAllAndOverride: jest.fn().mockReturnValue(false) } as never,
    );

    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(request.auth).toEqual(expect.objectContaining({ userId }));
  });

  it('keeps consent management, logout and account deletion accessible during onboarding', async () => {
    const request = { headers: { authorization: 'Bearer access-token' } };
    const guard = new JwtActiveGuard(
      { verifyAsync: jest.fn().mockResolvedValue({ sub: userId }) } as never,
      { query: jest.fn().mockResolvedValue({ rows: [{
        user_id: userId, role: 'user', is_banned: false, onboarding_complete: false,
      }] }) } as never,
      { legal } as never,
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
