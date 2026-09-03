import type { AdminAuthConfig } from '../config/config.service';

type AdminSessionCookieConfig = Pick<
  AdminAuthConfig,
  'cookieName' | 'secureCookie' | 'sessionAbsoluteTtlMillis'
>;

export function readAdminSessionCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const matches = header.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return undefined;
  const value = matches[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

export function adminSessionCookie(token: string, config: AdminSessionCookieConfig): string {
  const maxAge = Math.floor(config.sessionAbsoluteTtlMillis / 1_000);
  return `${config.cookieName}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${config.secureCookie ? '; Secure' : ''}`;
}

export function expiredAdminSessionCookie(config: AdminSessionCookieConfig): string {
  return `${config.cookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${config.secureCookie ? '; Secure' : ''}`;
}
