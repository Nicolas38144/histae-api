import type { ExecutionContext } from '@nestjs/common';
import { AdminSessionGuard, RecentAdminAuthenticationGuard } from '../../../src/admin-auth/admin-auth.guard';

const SESSION_TOKEN = 'a'.repeat(43);
const config = {
  adminAuth: {
    cookieName: 'histae_admin_session',
    origin: 'http://localhost:5173',
    secureCookie: false,
    recentAuthenticationMillis: 600_000,
  },
};

describe('AdminSessionGuard', () => {
  it('authenticates an active cookie session and attaches the database role', async () => {
    const request = { method: 'GET', headers: { cookie: `histae_admin_session=${SESSION_TOKEN}` } };
    const reply = { header: jest.fn() };
    const auth = { authenticateSession: jest.fn().mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      credential_id: '22222222-2222-4222-8222-222222222222',
      user_id: '33333333-3333-4333-8333-333333333333',
      role: 'admin',
      authenticated_at: new Date(),
      expires_at: new Date(Date.now() + 60_000),
    }) };
    const guard = new AdminSessionGuard(auth as never, config as never);

    await expect(guard.canActivate(context(request, reply))).resolves.toBe(true);
    expect(request).toEqual(expect.objectContaining({ auth: expect.objectContaining({
      account: expect.objectContaining({ role: 'admin' }),
      adminSession: expect.objectContaining({ credentialId: '22222222-2222-4222-8222-222222222222' }),
    }) }));
  });

  it('rejects a missing session and expires the browser cookie', async () => {
    const request = { method: 'GET', headers: {} };
    const reply = { header: jest.fn() };
    const guard = new AdminSessionGuard({ authenticateSession: jest.fn() } as never, config as never);

    await expect(guard.canActivate(context(request, reply))).rejects.toEqual(expect.objectContaining({
      status: 401, code: 'admin_session_invalid',
    }));
    expect(reply.header).toHaveBeenCalledWith('Set-Cookie', expect.stringContaining('Max-Age=0'));
  });

  it('requires the exact WebAuthn origin on mutations', async () => {
    const request = { method: 'POST', headers: { cookie: `histae_admin_session=${SESSION_TOKEN}`, origin: 'http://evil.test' } };
    const guard = new AdminSessionGuard({ authenticateSession: jest.fn() } as never, config as never);
    await expect(guard.canActivate(context(request, { header: jest.fn() }))).rejects.toEqual(expect.objectContaining({
      status: 403, code: 'invalid_admin_request_origin',
    }));
  });
});

describe('RecentAdminAuthenticationGuard', () => {
  it('requires a recent WebAuthn ceremony for credential management', () => {
    const guard = new RecentAdminAuthenticationGuard(config as never);
    const request = { auth: { adminSession: { authenticatedAt: new Date(Date.now() - 700_000) } } };
    expect(() => guard.canActivate(context(request, {}))).toThrow(expect.objectContaining({
      code: 'admin_reauthentication_required',
    }));
  });
});

function context(request: object, reply: object): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }) } as never;
}
