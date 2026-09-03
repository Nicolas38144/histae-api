import {
  adminSessionCookie,
  expiredAdminSessionCookie,
  readAdminSessionCookie,
} from '../../../src/admin-auth/admin-session-cookie';

const TOKEN = 'a'.repeat(43);

describe('administrator session cookie', () => {
  it('reads exactly one well-formed cookie and rejects duplicates', () => {
    expect(readAdminSessionCookie(`other=value; histae_admin_session=${TOKEN}`, 'histae_admin_session')).toBe(TOKEN);
    expect(readAdminSessionCookie(
      `histae_admin_session=${TOKEN}; histae_admin_session=${'b'.repeat(43)}`,
      'histae_admin_session',
    )).toBeUndefined();
    expect(readAdminSessionCookie('histae_admin_session=invalid', 'histae_admin_session')).toBeUndefined();
  });

  it('uses localhost-compatible flags in development and __Host-compatible flags in production', () => {
    const development = adminSessionCookie(TOKEN, {
      cookieName: 'histae_admin_session', secureCookie: false, sessionAbsoluteTtlMillis: 28_800_000,
    } as never);
    const production = adminSessionCookie(TOKEN, {
      cookieName: '__Host-histae_admin_session', secureCookie: true, sessionAbsoluteTtlMillis: 28_800_000,
    } as never);

    expect(development).toBe(`histae_admin_session=${TOKEN}; Path=/; Max-Age=28800; HttpOnly; SameSite=Strict`);
    expect(production).toContain('__Host-histae_admin_session=');
    expect(production).toContain('; Path=/;');
    expect(production).toContain('; HttpOnly; SameSite=Strict; Secure');
    expect(production).not.toContain('Domain=');
    expect(expiredAdminSessionCookie({
      cookieName: '__Host-histae_admin_session', secureCookie: true,
    } as never)).toContain('Max-Age=0');
  });
});
