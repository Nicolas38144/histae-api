import { Injectable } from '@nestjs/common';
import * as dotenv from 'dotenv';
import { parsePhoneKey } from '../crypto/phone-crypto';
import { jwtKeys } from './jwt-keys';
import {
  billingProvider, commaSeparated, duration, envOr, httpsUrl, identifier, integer,
  internalHttpOrigin, legalUrl, limit, maintenanceMode, numberInRange,
  objectStorageBucket, objectStorageEndpoint, objectStorageRegion, optionalBoolean,
  parseEnvironment, photoModerationProvider, required, smsProvider,
  smsRegion, smsSenderId, stripeReturnUrl, trustProxy, webAuthnOrigin, webAuthnRpId, webOrigins,
  type BillingProvider, type Environment, type LimitPolicy, type MaintenanceMode,
  type PhotoModerationProvider, type SmsProvider,
} from './config.parsers';

export { parseEnvironment } from './config.parsers';
export type { LimitPolicy } from './config.parsers';

type PushProvider = 'disabled' | 'fcm';

type RedisConfig = {
  address: string;
  password: string;
  db: number;
  tls: boolean;
  connectTimeoutMillis: number;
  commandTimeoutMillis: number;
};

export type PushConfig = {
  provider: PushProvider;
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
  timeoutMillis: number;
};

export type BillingConfig = {
  provider: BillingProvider;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  premiumProductId: string;
  premiumMonthlyPriceId: string;
  premiumAnnualPriceId: string;
  checkoutSuccessUrl: string;
  checkoutCancelUrl: string;
  portalReturnUrl: string;
  automaticTax: boolean;
  allowPromotionCodes: boolean;
  timeoutMillis: number;
  maxNetworkRetries: number;
};

export type ObjectStorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
};

export type PhotoModerationConfig = {
  provider: PhotoModerationProvider;
  endpoint: string;
  token: string;
  timeoutMillis: number;
  minSharpnessScore: number;
  nsfwReviewThreshold: number;
};

export type AdminAuthConfig = {
  rpId: string;
  origin: string;
  rpName: string;
  challengeTtlMillis: number;
  bootstrapTtlMillis: number;
  sessionIdleTtlMillis: number;
  sessionAbsoluteTtlMillis: number;
  recentAuthenticationMillis: number;
  cookieName: string;
  secureCookie: boolean;
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
  readonly jwt: { secret: string; activeKid: string; verificationKeys: ReadonlyMap<string, string>; accessTtlMs: number; refreshTtlMs: number };
  readonly accountDeletionTokenTtlMs: number;
  readonly phone: { encryptionKey: string; hashKey: string };
  readonly sms: {
    provider: SmsProvider;
    endpoint: string;
    apiKey: string;
    senderId: string;
    region: string;
    timeoutMillis: number;
    otpTtlMillis: number;
  };
  readonly scylla: ScyllaConfig;
  readonly redis: RedisConfig;
  readonly push: PushConfig;
  readonly billing: BillingConfig;
  readonly objectStorage: ObjectStorageConfig;
  readonly photoModeration: PhotoModerationConfig;
  readonly adminAuth: AdminAuthConfig;
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
  readonly trustProxy: boolean | string[];
  readonly corsOrigins: string[];
  readonly maintenanceMode: MaintenanceMode;
  readonly rateLimit: {
    store: 'memory' | 'redis';
    global: LimitPolicy;
    otp: LimitPolicy;
    refresh: LimitPolicy;
    feed: LimitPolicy;
    message: LimitPolicy;
    dataExport: LimitPolicy;
    report: LimitPolicy;
    photo: LimitPolicy;
    swipe: LimitPolicy;
    billing: LimitPolicy;
    billingWebhook: LimitPolicy;
    adminAuth: LimitPolicy;
  };

  constructor() {
    dotenv.config();
    this.env = parseEnvironment(process.env.ENV);
    this.port = integer(envOr('PORT', '8080'), 'PORT', 1, 65535);
    const adminAuthOrigin = webAuthnOrigin(
      envOr('ADMIN_WEBAUTHN_ORIGIN', this.env === 'production' ? '' : 'http://localhost:5173'),
      this.env,
    );
    const adminAuthRpId = webAuthnRpId(
      envOr('ADMIN_WEBAUTHN_RP_ID', new URL(adminAuthOrigin).hostname),
      adminAuthOrigin,
      this.env,
    );
    const adminAuthRpName = envOr('ADMIN_WEBAUTHN_RP_NAME', 'Histae Administration');
    if (adminAuthRpName.length > 64 || [...adminAuthRpName].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })) {
      throw new Error('config: ADMIN_WEBAUTHN_RP_NAME must contain 1 to 64 printable characters');
    }
    const challengeTtlMillis = duration(envOr('ADMIN_WEBAUTHN_CHALLENGE_TTL', '5m'), 'ADMIN_WEBAUTHN_CHALLENGE_TTL');
    const bootstrapTtlMillis = duration(envOr('ADMIN_WEBAUTHN_BOOTSTRAP_TTL', '15m'), 'ADMIN_WEBAUTHN_BOOTSTRAP_TTL');
    const sessionIdleTtlMillis = duration(envOr('ADMIN_SESSION_IDLE_TTL', '30m'), 'ADMIN_SESSION_IDLE_TTL');
    const sessionAbsoluteTtlMillis = duration(envOr('ADMIN_SESSION_ABSOLUTE_TTL', '8h'), 'ADMIN_SESSION_ABSOLUTE_TTL');
    const recentAuthenticationMillis = duration(envOr('ADMIN_RECENT_AUTH_TTL', '10m'), 'ADMIN_RECENT_AUTH_TTL');
    if (challengeTtlMillis < 60_000 || challengeTtlMillis > 10 * 60_000) {
      throw new Error('config: ADMIN_WEBAUTHN_CHALLENGE_TTL must be between 1m and 10m');
    }
    if (bootstrapTtlMillis < 5 * 60_000 || bootstrapTtlMillis > 60 * 60_000) {
      throw new Error('config: ADMIN_WEBAUTHN_BOOTSTRAP_TTL must be between 5m and 1h');
    }
    if (sessionIdleTtlMillis < 5 * 60_000 || sessionIdleTtlMillis > 2 * 60 * 60_000
      || sessionAbsoluteTtlMillis < sessionIdleTtlMillis || sessionAbsoluteTtlMillis > 24 * 60 * 60_000) {
      throw new Error('config: administrator session TTLs are outside the allowed range');
    }
    if (recentAuthenticationMillis > sessionIdleTtlMillis) {
      throw new Error('config: ADMIN_RECENT_AUTH_TTL must not exceed ADMIN_SESSION_IDLE_TTL');
    }
    this.adminAuth = {
      rpId: adminAuthRpId,
      origin: adminAuthOrigin,
      rpName: adminAuthRpName,
      challengeTtlMillis,
      bootstrapTtlMillis,
      sessionIdleTtlMillis,
      sessionAbsoluteTtlMillis,
      recentAuthenticationMillis,
      cookieName: this.env === 'production' ? '__Host-histae_admin_session' : 'histae_admin_session',
      secureCookie: this.env === 'production',
    };
    const jwtSecret = required('JWT_SECRET');
    if (Buffer.byteLength(jwtSecret) < 32) throw new Error('config: JWT_SECRET must contain at least 32 bytes');
    const encryptionKey = required('PHONE_ENCRYPTION_KEY');
    const hashKey = required('PHONE_HASH_KEY');
    const encryptionKeyBytes = parsePhoneKey(encryptionKey);
    const hashKeyBytes = parsePhoneKey(hashKey);
    const jwtSecretBytes = Buffer.from(jwtSecret, 'utf8');
    if (encryptionKeyBytes.equals(hashKeyBytes)
      || encryptionKeyBytes.equals(jwtSecretBytes)
      || hashKeyBytes.equals(jwtSecretBytes)) {
      throw new Error('config: JWT_SECRET, PHONE_ENCRYPTION_KEY, and PHONE_HASH_KEY must be distinct');
    }

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
    if (this.env === 'production' && !this.postgres.ssl) {
      throw new Error('config: production PostgreSQL requires TLS');
    }
    const objectStorageAccessKey = envOr('OBJECT_STORAGE_ACCESS_KEY', this.env === 'production' ? '' : 'histae-dev');
    const objectStorageSecretKey = envOr('OBJECT_STORAGE_SECRET_KEY', this.env === 'production' ? '' : 'histae-dev-secret-change-me');
    if (!objectStorageAccessKey || !objectStorageSecretKey) {
      throw new Error('config: OBJECT_STORAGE_ACCESS_KEY and OBJECT_STORAGE_SECRET_KEY are required');
    }
    this.objectStorage = {
      endpoint: objectStorageEndpoint(envOr('OBJECT_STORAGE_ENDPOINT', 'http://127.0.0.1:8333'), this.env),
      region: objectStorageRegion(envOr('OBJECT_STORAGE_REGION', 'us-east-1')),
      bucket: objectStorageBucket(envOr('OBJECT_STORAGE_BUCKET', 'histae-photos')),
      accessKey: objectStorageAccessKey,
      secretKey: objectStorageSecretKey,
      forcePathStyle: optionalBoolean('OBJECT_STORAGE_FORCE_PATH_STYLE', true),
    };
    const photoModerationProviderValue = photoModerationProvider(
      envOr('PHOTO_MODERATION_PROVIDER', 'disabled'),
    );
    const photoModerationToken = envOr('PHOTO_MODERATION_TOKEN', '');
    if (photoModerationProviderValue === 'local_http' && Buffer.byteLength(photoModerationToken) < 32) {
      throw new Error('config: PHOTO_MODERATION_TOKEN must contain at least 32 bytes when local photo moderation is enabled');
    }
    const photoModerationTimeout = duration(
      envOr('PHOTO_MODERATION_TIMEOUT', '5s'),
      'PHOTO_MODERATION_TIMEOUT',
    );
    if (photoModerationTimeout > 30_000) {
      throw new Error('config: PHOTO_MODERATION_TIMEOUT must not exceed 30s');
    }
    this.photoModeration = {
      provider: photoModerationProviderValue,
      endpoint: internalHttpOrigin(
        envOr('PHOTO_MODERATION_ENDPOINT', 'http://127.0.0.1:8090'),
        'PHOTO_MODERATION_ENDPOINT',
      ),
      token: photoModerationToken,
      timeoutMillis: photoModerationTimeout,
      minSharpnessScore: numberInRange(
        envOr('PHOTO_MODERATION_MIN_SHARPNESS', '80'),
        'PHOTO_MODERATION_MIN_SHARPNESS',
        0,
        1_000_000,
      ),
      nsfwReviewThreshold: numberInRange(
        envOr('PHOTO_MODERATION_NSFW_REVIEW_THRESHOLD', '0.7'),
        'PHOTO_MODERATION_NSFW_REVIEW_THRESHOLD',
        0,
        1,
      ),
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
    const accessTtlMs = duration(envOr('JWT_ACCESS_TTL', '15m'), 'JWT_ACCESS_TTL');
    const refreshTtlMs = duration(envOr('JWT_REFRESH_TTL', '4320h'), 'JWT_REFRESH_TTL');
    if (accessTtlMs < 60_000 || accessTtlMs > 60 * 60_000) {
      throw new Error('config: JWT_ACCESS_TTL must be between 1m and 1h');
    }
    if (refreshTtlMs < 60 * 60_000 || refreshTtlMs > 4_320 * 60 * 60_000 || refreshTtlMs <= accessTtlMs) {
      throw new Error('config: JWT_REFRESH_TTL must be longer than JWT_ACCESS_TTL and no more than 4320h');
    }
    const activeKid = envOr('JWT_ACTIVE_KID', 'primary');
    const verificationKeys = jwtKeys(activeKid, jwtSecret, envOr('JWT_PREVIOUS_KEYS', '{}'));
    for (const key of verificationKeys.values()) {
      if (Buffer.from(key).equals(encryptionKeyBytes) || Buffer.from(key).equals(hashKeyBytes)) {
        throw new Error('config: JWT keys must be distinct from phone encryption and hash keys');
      }
    }
    this.jwt = { secret: jwtSecret, activeKid, verificationKeys, accessTtlMs, refreshTtlMs };
    this.accountDeletionTokenTtlMs = duration(envOr('ACCOUNT_DELETION_TOKEN_TTL', '10m'), 'ACCOUNT_DELETION_TOKEN_TTL');
    if (this.accountDeletionTokenTtlMs < 60_000 || this.accountDeletionTokenTtlMs > 30 * 60_000) {
      throw new Error('config: ACCOUNT_DELETION_TOKEN_TTL must be between 1m and 30m');
    }
    this.phone = { encryptionKey, hashKey };
    const smsProviderValue = smsProvider(envOr('SMS_PROVIDER', this.env === 'production' ? 'sweego' : 'disabled'));
    const sweegoApiKey = process.env.SWEEGO_API_KEY?.trim() ?? '';
    const sweegoSenderId = process.env.SWEEGO_SMS_SENDER_ID?.trim() ?? '';
    if (this.env === 'production' && smsProviderValue !== 'sweego') {
      throw new Error('config: production requires SMS_PROVIDER=sweego');
    }
    if (smsProviderValue === 'sweego' && (!sweegoApiKey || !sweegoSenderId)) {
      throw new Error('config: SWEEGO_API_KEY and SWEEGO_SMS_SENDER_ID are required when SMS_PROVIDER=sweego');
    }
    const smsTimeoutMillis = duration(envOr('SWEEGO_TIMEOUT', '10s'), 'SWEEGO_TIMEOUT');
    if (smsTimeoutMillis > 30_000) throw new Error('config: SWEEGO_TIMEOUT must not exceed 30s');
    const otpTtlMillis = duration(envOr('OTP_TTL', '10m'), 'OTP_TTL');
    if (otpTtlMillis < 60_000 || otpTtlMillis > 30 * 60_000) throw new Error('config: OTP_TTL must be between 1m and 30m');
    this.sms = {
      provider: smsProviderValue,
      endpoint: httpsUrl(envOr('SWEEGO_API_URL', 'https://api.sweego.io/send'), 'SWEEGO_API_URL'),
      apiKey: sweegoApiKey,
      senderId: sweegoSenderId ? smsSenderId(sweegoSenderId) : '',
      region: smsRegion(envOr('SWEEGO_SMS_REGION', 'FR')),
      timeoutMillis: smsTimeoutMillis,
      otpTtlMillis,
    };
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
    this.trustProxy = trustProxy(envOr('TRUST_PROXY', 'false'), this.env);
    this.corsOrigins = webOrigins(envOr('CORS_ORIGINS', this.env === 'development' ? 'http://localhost:5173' : ''), this.env);
    this.maintenanceMode = maintenanceMode(envOr('MAINTENANCE_MODE', this.env === 'production' ? 'disabled' : 'api'));
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
    const pushProvider = envOr('PUSH_PROVIDER', 'disabled').toLowerCase();
    if (pushProvider !== 'disabled' && pushProvider !== 'fcm') throw new Error('config: PUSH_PROVIDER must be disabled or fcm');
    const pushProjectId = envOr('FIREBASE_PROJECT_ID', '');
    const pushClientEmail = envOr('FIREBASE_CLIENT_EMAIL', '');
    const pushPrivateKey = (process.env.FIREBASE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n').trim();
    if (pushProvider === 'fcm' && (!pushProjectId || !pushClientEmail || !pushPrivateKey)) {
      throw new Error('config: Firebase project ID, client email, and private key are required when PUSH_PROVIDER=fcm');
    }
    this.push = {
      provider: pushProvider,
      projectId: pushProjectId,
      clientEmail: pushClientEmail,
      privateKey: pushPrivateKey,
      tokenUri: httpsUrl(envOr('FIREBASE_TOKEN_URI', 'https://oauth2.googleapis.com/token'), 'FIREBASE_TOKEN_URI'),
      timeoutMillis: duration(envOr('PUSH_TIMEOUT', '5s'), 'PUSH_TIMEOUT'),
    };
    if (this.push.timeoutMillis > 30_000) throw new Error('config: PUSH_TIMEOUT must not exceed 30s');
    const billingProviderValue = billingProvider(envOr('BILLING_PROVIDER', this.env === 'production' ? 'stripe' : 'disabled'));
    const stripeSecretKey = envOr('STRIPE_SECRET_KEY', '');
    const stripeWebhookSecret = envOr('STRIPE_WEBHOOK_SECRET', '');
    const premiumProductId = envOr('STRIPE_PREMIUM_PRODUCT_ID', '');
    const premiumMonthlyPriceId = envOr('STRIPE_PREMIUM_MONTHLY_PRICE_ID', '');
    const premiumAnnualPriceId = envOr('STRIPE_PREMIUM_ANNUAL_PRICE_ID', '');
    const checkoutSuccessUrl = envOr('STRIPE_CHECKOUT_SUCCESS_URL', '');
    const checkoutCancelUrl = envOr('STRIPE_CHECKOUT_CANCEL_URL', '');
    const portalReturnUrl = envOr('STRIPE_PORTAL_RETURN_URL', '');
    if (this.env === 'production' && billingProviderValue !== 'stripe') {
      throw new Error('config: production requires BILLING_PROVIDER=stripe');
    }
    if (billingProviderValue === 'stripe') {
      if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(stripeSecretKey)) throw new Error('config: STRIPE_SECRET_KEY must be a Stripe secret key');
      if (this.env === 'production' && !stripeSecretKey.startsWith('sk_live_')) {
        throw new Error('config: production requires a live Stripe secret key');
      }
      if (this.env !== 'production' && !stripeSecretKey.startsWith('sk_test_')) {
        throw new Error('config: non-production environments require a Stripe test secret key');
      }
      if (!/^whsec_[A-Za-z0-9]+$/.test(stripeWebhookSecret)) throw new Error('config: STRIPE_WEBHOOK_SECRET must be a Stripe endpoint secret');
      if (!/^prod_[A-Za-z0-9]+$/.test(premiumProductId)) throw new Error('config: STRIPE_PREMIUM_PRODUCT_ID must be a Stripe product ID');
      if (!/^price_[A-Za-z0-9]+$/.test(premiumMonthlyPriceId) || !/^price_[A-Za-z0-9]+$/.test(premiumAnnualPriceId)
        || premiumMonthlyPriceId === premiumAnnualPriceId) {
        throw new Error('config: Stripe monthly and annual Price IDs must be distinct valid price IDs');
      }
    }
    const stripeTimeoutMillis = duration(envOr('STRIPE_TIMEOUT', '10s'), 'STRIPE_TIMEOUT');
    if (stripeTimeoutMillis > 30_000) throw new Error('config: STRIPE_TIMEOUT must not exceed 30s');
    this.billing = {
      provider: billingProviderValue,
      stripeSecretKey,
      stripeWebhookSecret,
      premiumProductId,
      premiumMonthlyPriceId,
      premiumAnnualPriceId,
      checkoutSuccessUrl: billingProviderValue === 'stripe' ? stripeReturnUrl(checkoutSuccessUrl, 'STRIPE_CHECKOUT_SUCCESS_URL', true) : '',
      checkoutCancelUrl: billingProviderValue === 'stripe' ? stripeReturnUrl(checkoutCancelUrl, 'STRIPE_CHECKOUT_CANCEL_URL') : '',
      portalReturnUrl: billingProviderValue === 'stripe' ? stripeReturnUrl(portalReturnUrl, 'STRIPE_PORTAL_RETURN_URL') : '',
      automaticTax: optionalBoolean('STRIPE_AUTOMATIC_TAX', false),
      allowPromotionCodes: optionalBoolean('STRIPE_ALLOW_PROMOTION_CODES', false),
      timeoutMillis: stripeTimeoutMillis,
      maxNetworkRetries: integer(envOr('STRIPE_MAX_NETWORK_RETRIES', '2'), 'STRIPE_MAX_NETWORK_RETRIES', 0, 5),
    };
    this.rateLimit = {
      store,
      global: limit('RATE_LIMIT_GLOBAL', 100, '1m'),
      otp: limit('RATE_LIMIT_OTP', 5, '1h'),
      refresh: limit('RATE_LIMIT_REFRESH', 30, '15m'),
      feed: limit('RATE_LIMIT_FEED', 60, '1m'),
      message: limit('RATE_LIMIT_MESSAGE', 60, '1m'),
      dataExport: limit('RATE_LIMIT_DATA_EXPORT', 5, '1h'),
      report: limit('RATE_LIMIT_REPORT', 5, '1h'),
      photo: limit('RATE_LIMIT_PHOTO', 10, '1h'),
      swipe: limit('RATE_LIMIT_SWIPE', 120, '1m'),
      billing: limit('RATE_LIMIT_BILLING', 10, '1m'),
      billingWebhook: limit('RATE_LIMIT_BILLING_WEBHOOK', 300, '1m'),
      adminAuth: limit('RATE_LIMIT_ADMIN_AUTH', 10, '5m'),
    };
  }
}

let sharedConfig: ConfigService | undefined;

export function applicationConfig(): ConfigService {
  sharedConfig ??= new ConfigService();
  return sharedConfig;
}
