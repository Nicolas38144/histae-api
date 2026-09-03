import { isIP } from 'node:net';

export type Environment = 'development' | 'test' | 'production';
export type MaintenanceMode = 'api' | 'worker' | 'disabled';
export type SmsProvider = 'disabled' | 'sweego';
export type BillingProvider = 'disabled' | 'stripe';
export type PhotoModerationProvider = 'disabled' | 'local_http';
export type LimitPolicy = { max: number; windowMs: number };

export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`config: required environment variable ${JSON.stringify(name)} is not set`);
  return value;
}

export function parseEnvironment(value: string | undefined): Environment {
  const environment = value?.trim().toLowerCase();
  if (environment === 'development' || environment === 'test' || environment === 'production') return environment;
  throw new Error('config: ENV must be development, test, or production');
}

export function envOr(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

export function commaSeparated(value: string, name: string): string[] {
  const values = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (!values.length || values.some((item) => /[\s/]/.test(item))) throw new Error(`config: invalid ${name}`);
  return values;
}

export function identifier(value: string, name: string): string {
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(value)) throw new Error(`config: invalid ${name}`);
  return value;
}

export function integer(value: string, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!/^[0-9]+$/.test(value)) throw new Error(`config: invalid ${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`config: invalid ${name}`);
  return parsed;
}

export function optionalBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? fallback : boolean(value, name);
}

export function maintenanceMode(value: string): MaintenanceMode {
  if (value === 'api' || value === 'worker' || value === 'disabled') return value;
  throw new Error('config: MAINTENANCE_MODE must be api, worker, or disabled');
}

export function smsProvider(value: string): SmsProvider {
  if (value === 'disabled' || value === 'sweego') return value;
  throw new Error('config: SMS_PROVIDER must be disabled or sweego');
}

export function trustProxy(value: string, environment: Environment): boolean | string[] {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'false') return false;
  if (normalized === 'true') {
    if (environment === 'production') {
      throw new Error('config: production TRUST_PROXY must list explicit proxy IP addresses or CIDR ranges');
    }
    return true;
  }
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!entries.length || entries.some((entry) => !isTrustedProxyEntry(entry))) {
    throw new Error('config: TRUST_PROXY must be false, true outside production, or a comma-separated IP/CIDR list');
  }
  return entries;
}

export function billingProvider(value: string): BillingProvider {
  if (value === 'disabled' || value === 'stripe') return value;
  throw new Error('config: BILLING_PROVIDER must be disabled or stripe');
}

export function photoModerationProvider(value: string): PhotoModerationProvider {
  if (value === 'disabled' || value === 'local_http') return value;
  throw new Error('config: PHOTO_MODERATION_PROVIDER must be disabled or local_http');
}

export function numberInRange(value: string, name: string, min: number, max: number): number {
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(value)) throw new Error(`config: invalid ${name}`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`config: invalid ${name}`);
  return parsed;
}

export function internalHttpOrigin(value: string, name: string): string {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error();
    return parsed.toString();
  } catch {
    throw new Error(`config: ${name} must be an absolute HTTP(S) origin`);
  }
}

export function webOrigins(value: string, environment: Environment): string[] {
  if (!value.trim()) return [];
  const origins = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (new Set(origins).size !== origins.length) throw new Error('config: CORS_ORIGINS contains duplicates');
  for (const origin of origins) {
    try {
      const parsed = new URL(origin);
      if (parsed.origin !== origin || (parsed.protocol !== 'https:' && (environment === 'production' || parsed.protocol !== 'http:'))) throw new Error();
    } catch {
      throw new Error('config: CORS_ORIGINS must contain comma-separated HTTP(S) origins and HTTPS in production');
    }
  }
  return origins;
}

export function smsSenderId(value: string): string {
  if (!/^[A-Za-z0-9]{3,11}$/.test(value)) {
    throw new Error('config: SWEEGO_SMS_SENDER_ID must contain 3 to 11 letters or digits');
  }
  return value;
}

export function smsRegion(value: string): string {
  const normalized = value.toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) throw new Error('config: SWEEGO_SMS_REGION must be an ISO 3166-1 alpha-2 code');
  if (normalized !== 'FR') throw new Error('config: SWEEGO_SMS_REGION must be FR while OTP delivery is restricted to French phone numbers');
  return normalized;
}

export function httpsUrl(value: string, name: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') throw new Error('invalid protocol');
    return parsed.toString();
  } catch {
    throw new Error(`config: ${name} must be an absolute HTTPS URL`);
  }
}

export function stripeReturnUrl(value: string, name: string, checkoutSuccess = false): string {
  if (checkoutSuccess && !value.includes('{CHECKOUT_SESSION_ID}')) {
    throw new Error(`config: ${name} must contain the literal {CHECKOUT_SESSION_ID} placeholder`);
  }
  try {
    const parsed = new URL(value.replace('{CHECKOUT_SESSION_ID}', 'cs_test_validation'));
    if (parsed.protocol !== 'https:') throw new Error('invalid protocol');
    return value;
  } catch {
    throw new Error(`config: ${name} must be an absolute HTTPS URL`);
  }
}

export function objectStorageEndpoint(value: string, environment: Environment): string {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== 'https:' && (environment === 'production' || parsed.protocol !== 'http:'))
      || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error();
    return parsed.toString();
  } catch {
    throw new Error('config: OBJECT_STORAGE_ENDPOINT must be an absolute HTTP(S) origin and HTTPS in production');
  }
}

export function objectStorageRegion(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) throw new Error('config: invalid OBJECT_STORAGE_REGION');
  return value;
}

export function objectStorageBucket(value: string): string {
  if (value.length < 3 || value.length > 63 || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value)
    || value.includes('..') || /^\d+\.\d+\.\d+\.\d+$/.test(value)) {
    throw new Error('config: invalid OBJECT_STORAGE_BUCKET');
  }
  return value;
}

export function legalUrl(value: string, name: string, environment: Environment): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && (environment === 'production' || parsed.protocol !== 'http:')) throw new Error('invalid protocol');
    return parsed.toString();
  } catch {
    throw new Error(`config: ${name} must be an absolute HTTP(S) URL and HTTPS in production`);
  }
}

export function duration(value: string, name: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value);
  if (!match) throw new Error(`config: invalid ${name}`);
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as 'ms' | 's' | 'm' | 'h'];
  const result = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`config: invalid ${name}`);
  return result;
}

export function limit(prefix: string, defaultMax: number, defaultWindow: string): LimitPolicy {
  return {
    max: integer(envOr(prefix, String(defaultMax)), prefix, 1),
    windowMs: duration(envOr(`${prefix}_WINDOW`, defaultWindow), `${prefix}_WINDOW`),
  };
}

function boolean(value: string, name: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`config: invalid ${name}`);
}

function isTrustedProxyEntry(value: string): boolean {
  const [address, prefix, extra] = value.split('/');
  if (extra !== undefined || isIP(address ?? '') === 0) return false;
  if (prefix === undefined) return true;
  if (!/^[0-9]{1,3}$/.test(prefix)) return false;
  const bits = isIP(address) === 4 ? 32 : 128;
  return Number(prefix) <= bits;
}
