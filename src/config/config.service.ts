import { Injectable } from '@nestjs/common';
import * as dotenv from 'dotenv';
import { parsePhoneKey } from '../crypto/phone-crypto';

export type LimitPolicy = { max: number; windowMs: number };
type Environment = 'development' | 'test' | 'production';
type MaintenanceMode = 'api' | 'worker' | 'disabled';

type RedisConfig = {
  address: string;
  password: string;
  db: number;
  tls: boolean;
  connectTimeoutMillis: number;
  commandTimeoutMillis: number;
};

export type ScyllaConfig = {
  enabled: boolean;
  contactPoints: string[];
  port: number;
  localDataCenter: string;
  keyspace: string;
  username: string;
  password: string;
  tls: boolean;
  tlsCaPath: string;
  replicationFactor: number;
  connectTimeoutMillis: number;
  requestTimeoutMillis: number;
};

@Injectable()
export class ConfigService {
  readonly env: Environment;
  readonly port: number;
  readonly postgres: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    ssl: boolean;
    max: number;
    connectionTimeoutMillis: number;
    idleTimeoutMillis: number;
    statement_timeout: number;
    idle_in_transaction_session_timeout: number;
    application_name: string;
  };
  readonly jwt: { secret: string; accessTtlMs: number; refreshTtlMs: number };
  readonly phone: { encryptionKey: string; hashKey: string };
  readonly scylla: ScyllaConfig;
  readonly redis: RedisConfig;
  readonly legal: {
    termsVersion: string;
    privacyVersion: string;
    sensitiveDataConsentVersion: string;
    locationConsentVersion: string;
    termsUrl: string;
    privacyUrl: string;
    sensitiveDataConsentUrl: string;
    locationConsentUrl: string;
    reviewReference: string;
  };
  readonly trustProxy: boolean;
  readonly openApiEnabled: boolean;
  readonly maintenanceMode: MaintenanceMode;
  readonly devBootstrapSecret: string;
  readonly rateLimit: {
    store: 'memory' | 'redis';
    global: LimitPolicy;
    otp: LimitPolicy;
    registration: LimitPolicy;
    refresh: LimitPolicy;
    feed: LimitPolicy;
    message: LimitPolicy;
    dataExport: LimitPolicy;
    report: LimitPolicy;
    swipe: LimitPolicy;
  };

  constructor() {
    dotenv.config();
    this.env = parseEnvironment(process.env.ENV);
    this.port = integer(envOr('PORT', '8080'), 'PORT', 1, 65535);
    const jwtSecret = required('JWT_SECRET');
    if (Buffer.byteLength(jwtSecret) < 32) throw new Error('config: JWT_SECRET must contain at least 32 bytes');
    const encryptionKey = required('PHONE_ENCRYPTION_KEY');
    const hashKey = required('PHONE_HASH_KEY');
    parsePhoneKey(encryptionKey);
    parsePhoneKey(hashKey);

    this.postgres = {
      host: required('POSTGRES_HOST'),
      port: integer(envOr('POSTGRES_PORT', '5432'), 'POSTGRES_PORT', 1, 65535),
      user: required('POSTGRES_USER'),
      password: required('POSTGRES_PASSWORD'),
      database: required('POSTGRES_DB'),
      ssl: envOr('POSTGRES_SSLMODE', 'disable') !== 'disable',
      max: integer(envOr('POSTGRES_POOL_MAX', '20'), 'POSTGRES_POOL_MAX', 1, 200),
      connectionTimeoutMillis: duration(envOr('POSTGRES_CONNECT_TIMEOUT', '5s'), 'POSTGRES_CONNECT_TIMEOUT'),
      idleTimeoutMillis: duration(envOr('POSTGRES_IDLE_TIMEOUT', '30s'), 'POSTGRES_IDLE_TIMEOUT'),
      statement_timeout: duration(envOr('POSTGRES_STATEMENT_TIMEOUT', '15s'), 'POSTGRES_STATEMENT_TIMEOUT'),
      idle_in_transaction_session_timeout: duration(envOr('POSTGRES_IDLE_TRANSACTION_TIMEOUT', '30s'), 'POSTGRES_IDLE_TRANSACTION_TIMEOUT'),
      application_name: 'histae-api',
    };
    const scyllaUsername = envOr('SCYLLA_USERNAME', '');
    const scyllaPassword = process.env.SCYLLA_PASSWORD ?? '';
    if (!!scyllaUsername !== !!scyllaPassword) throw new Error('config: SCYLLA_USERNAME and SCYLLA_PASSWORD must be set together');
    this.scylla = {
      enabled: optionalBoolean('SCYLLA_ENABLED', false),
      contactPoints: commaSeparated(envOr('SCYLLA_CONTACT_POINTS', '127.0.0.1'), 'SCYLLA_CONTACT_POINTS'),
      port: integer(envOr('SCYLLA_PORT', '9042'), 'SCYLLA_PORT', 1, 65535),
      localDataCenter: identifier(envOr('SCYLLA_LOCAL_DATACENTER', 'datacenter1'), 'SCYLLA_LOCAL_DATACENTER'),
      keyspace: identifier(envOr('SCYLLA_KEYSPACE', 'histae_discovery'), 'SCYLLA_KEYSPACE'),
      username: scyllaUsername,
      password: scyllaPassword,
      tls: optionalBoolean('SCYLLA_TLS', false),
      tlsCaPath: envOr('SCYLLA_TLS_CA_PATH', ''),
      replicationFactor: integer(envOr('SCYLLA_REPLICATION_FACTOR', this.env === 'production' ? '3' : '1'), 'SCYLLA_REPLICATION_FACTOR', 1, 9),
      connectTimeoutMillis: duration(envOr('SCYLLA_CONNECT_TIMEOUT', '10s'), 'SCYLLA_CONNECT_TIMEOUT'),
      requestTimeoutMillis: duration(envOr('SCYLLA_REQUEST_TIMEOUT', '5s'), 'SCYLLA_REQUEST_TIMEOUT'),
    };
    if (this.env === 'production' && !this.scylla.enabled) throw new Error('config: production requires SCYLLA_ENABLED=true');
    if (this.env === 'production' && (!this.scylla.tls || !this.scylla.username)) {
      throw new Error('config: production ScyllaDB requires TLS and username/password authentication');
    }
    if (this.env === 'production' && this.scylla.replicationFactor < 3) {
      throw new Error('config: production ScyllaDB requires SCYLLA_REPLICATION_FACTOR >= 3');
    }
    this.jwt = {
      secret: jwtSecret,
      accessTtlMs: duration(envOr('JWT_ACCESS_TTL', '15m'), 'JWT_ACCESS_TTL'),
      refreshTtlMs: duration(envOr('JWT_REFRESH_TTL', '4320h'), 'JWT_REFRESH_TTL'),
    };
    this.phone = { encryptionKey, hashKey };
    const termsVersion = envOr('TERMS_OF_SERVICE_VERSION', '');
    const privacyVersion = envOr('PRIVACY_POLICY_VERSION', '');
    const sensitiveDataConsentVersion = envOr('SENSITIVE_DATA_CONSENT_VERSION', '');
    const locationConsentVersion = envOr('LOCATION_CONSENT_VERSION', '');
    const termsUrl = envOr('TERMS_OF_SERVICE_URL', '');
    const privacyUrl = envOr('PRIVACY_POLICY_URL', '');
    const sensitiveDataConsentUrl = envOr('SENSITIVE_DATA_CONSENT_URL', '');
    const locationConsentUrl = envOr('LOCATION_CONSENT_URL', '');
    const legalReviewReference = envOr('LEGAL_REVIEW_REFERENCE', '');
    if (this.env === 'production' && (!termsVersion || !privacyVersion || !sensitiveDataConsentVersion || !locationConsentVersion
      || !termsUrl || !privacyUrl || !sensitiveDataConsentUrl || !locationConsentUrl || !legalReviewReference)) {
      throw new Error('config: production requires all legal versions, URLs, and LEGAL_REVIEW_REFERENCE');
    }
    const fallbackLegalBase = 'https://example.invalid/histae/legal';
    this.legal = {
      termsVersion: termsVersion || 'development-unversioned',
      privacyVersion: privacyVersion || 'development-unversioned',
      sensitiveDataConsentVersion: sensitiveDataConsentVersion || 'development-unversioned',
      locationConsentVersion: locationConsentVersion || 'development-unversioned',
      termsUrl: legalUrl(termsUrl || `${fallbackLegalBase}/terms`, 'TERMS_OF_SERVICE_URL', this.env),
      privacyUrl: legalUrl(privacyUrl || `${fallbackLegalBase}/privacy`, 'PRIVACY_POLICY_URL', this.env),
      sensitiveDataConsentUrl: legalUrl(sensitiveDataConsentUrl || `${fallbackLegalBase}/sensitive-data`, 'SENSITIVE_DATA_CONSENT_URL', this.env),
      locationConsentUrl: legalUrl(locationConsentUrl || `${fallbackLegalBase}/location`, 'LOCATION_CONSENT_URL', this.env),
      reviewReference: legalReviewReference || 'not-reviewed-for-production',
    };
    this.trustProxy = boolean(envOr('TRUST_PROXY', 'false'), 'TRUST_PROXY');
    this.openApiEnabled = optionalBoolean('OPENAPI_ENABLED', this.env !== 'production');
    this.maintenanceMode = maintenanceMode(envOr('MAINTENANCE_MODE', this.env === 'production' ? 'disabled' : 'api'));
    this.devBootstrapSecret = process.env.DEV_BOOTSTRAP_SECRET?.trim() ?? '';

    const store = envOr('RATE_LIMIT_STORE', 'memory').toLowerCase();
    if (store !== 'memory' && store !== 'redis') throw new Error('config: RATE_LIMIT_STORE must be memory or redis');
    if (this.env === 'production' && store !== 'redis') throw new Error('config: production requires RATE_LIMIT_STORE=redis');
    const configuredRedisAddress = envOr('REDIS_ADDR', '');
    const redisAddress = configuredRedisAddress || 'localhost:6379';
    const redisPassword = process.env.REDIS_PASSWORD ?? '';
    const redisDb = integer(envOr('REDIS_DB', '0'), 'REDIS_DB', 0, 15);
    const redisTls = optionalBoolean('REDIS_TLS', false);
    if (store === 'redis' && !configuredRedisAddress) throw new Error('config: REDIS_ADDR is required when RATE_LIMIT_STORE=redis');
    if (redisAddress && !/^[a-zA-Z0-9._-]+:\d{1,5}$/.test(redisAddress)) throw new Error('config: REDIS_ADDR must use host:port');
    if (this.env === 'production' && (!redisTls || !redisPassword)) {
      throw new Error('config: production Redis requires TLS and a password');
    }
    this.redis = {
      address: redisAddress,
      password: redisPassword,
      db: redisDb,
      tls: redisTls,
      connectTimeoutMillis: duration(envOr('REDIS_CONNECT_TIMEOUT', '5s'), 'REDIS_CONNECT_TIMEOUT'),
      commandTimeoutMillis: duration(envOr('REDIS_COMMAND_TIMEOUT', '1s'), 'REDIS_COMMAND_TIMEOUT'),
    };
    this.rateLimit = {
      store,
      global: limit('RATE_LIMIT_GLOBAL', 100, '1m'),
      otp: limit('RATE_LIMIT_OTP', 5, '1h'),
      registration: limit('RATE_LIMIT_REGISTRATION', 5, '1h'),
      refresh: limit('RATE_LIMIT_REFRESH', 30, '15m'),
      feed: limit('RATE_LIMIT_FEED', 60, '1m'),
      message: limit('RATE_LIMIT_MESSAGE', 60, '1m'),
      dataExport: limit('RATE_LIMIT_DATA_EXPORT', 5, '1h'),
      report: limit('RATE_LIMIT_REPORT', 5, '1h'),
      swipe: limit('RATE_LIMIT_SWIPE', 120, '1m'),
    };
  }
}

let sharedConfig: ConfigService | undefined;

export function applicationConfig(): ConfigService {
  sharedConfig ??= new ConfigService();
  return sharedConfig;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`config: required environment variable ${JSON.stringify(name)} is not set`);
  return value;
}

export function parseEnvironment(value: string | undefined): Environment {
  const environment = value?.trim().toLowerCase();
  if (environment === 'development' || environment === 'test' || environment === 'production') return environment;
  throw new Error('config: ENV must be development, test, or production');
}

function envOr(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function commaSeparated(value: string, name: string): string[] {
  const values = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (!values.length || values.some((item) => /[\s/]/.test(item))) throw new Error(`config: invalid ${name}`);
  return values;
}

function identifier(value: string, name: string): string {
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(value)) throw new Error(`config: invalid ${name}`);
  return value;
}

function integer(value: string, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!/^[0-9]+$/.test(value)) throw new Error(`config: invalid ${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`config: invalid ${name}`);
  return parsed;
}

function boolean(value: string, name: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`config: invalid ${name}`);
}

function optionalBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? fallback : boolean(value, name);
}

function maintenanceMode(value: string): MaintenanceMode {
  if (value === 'api' || value === 'worker' || value === 'disabled') return value;
  throw new Error('config: MAINTENANCE_MODE must be api, worker, or disabled');
}

function legalUrl(value: string, name: string, environment: Environment): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && (environment === 'production' || parsed.protocol !== 'http:')) throw new Error('invalid protocol');
    return parsed.toString();
  } catch {
    throw new Error(`config: ${name} must be an absolute HTTP(S) URL and HTTPS in production`);
  }
}

function duration(value: string, name: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value);
  if (!match) throw new Error(`config: invalid ${name}`);
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as 'ms' | 's' | 'm' | 'h'];
  const result = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`config: invalid ${name}`);
  return result;
}

function limit(prefix: string, defaultMax: number, defaultWindow: string): LimitPolicy {
  return {
    max: integer(envOr(prefix, String(defaultMax)), prefix, 1),
    windowMs: duration(envOr(`${prefix}_WINDOW`, defaultWindow), `${prefix}_WINDOW`),
  };
}
