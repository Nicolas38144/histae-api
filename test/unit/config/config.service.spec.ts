import { ConfigService, parseEnvironment } from '../../../src/config/config.service';

jest.mock('dotenv', () => ({ config: jest.fn() }));

describe('parseEnvironment', () => {
  it.each(['development', 'test', 'production'] as const)('accepts %s', (value) => {
    expect(parseEnvironment(value)).toBe(value);
  });

  it.each([undefined, '', 'staging', 'developmentish'])('fails closed for %p', (value) => {
    expect(() => parseEnvironment(value)).toThrow('config: ENV must be development, test, or production');
  });
});

describe('ConfigService SMS configuration', () => {
  const originalEnvironment = process.env;

  beforeEach(() => {
    process.env = baseEnvironment();
  });

  afterAll(() => {
    process.env = originalEnvironment;
  });

  it('accepts a valid French Sweego configuration', () => {
    process.env = baseEnvironment({
      SMS_PROVIDER: 'sweego',
      SWEEGO_API_KEY: 'sweego-test-key',
      SWEEGO_SMS_SENDER_ID: 'Histae',
    });

    expect(new ConfigService().sms).toEqual(expect.objectContaining({
      provider: 'sweego',
      endpoint: 'https://api.sweego.io/send',
      region: 'FR',
      timeoutMillis: 10_000,
      otpTtlMillis: 600_000,
    }));
  });

  it('requires the Sweego provider in production', () => {
    process.env = productionEnvironment({ SMS_PROVIDER: 'disabled' });

    expect(() => new ConfigService()).toThrow('config: production requires SMS_PROVIDER=sweego');
  });

  it('requires the API key and Sender ID when Sweego is enabled', () => {
    process.env = baseEnvironment({
      SMS_PROVIDER: 'sweego',
      SWEEGO_API_KEY: '',
      SWEEGO_SMS_SENDER_ID: 'Histae',
    });

    expect(() => new ConfigService()).toThrow('config: SWEEGO_API_KEY and SWEEGO_SMS_SENDER_ID are required');
  });

  it.each(['Hi', 'Histae!'])('rejects the invalid Sweego Sender ID %s', (senderId) => {
    process.env = baseEnvironment({
      SMS_PROVIDER: 'sweego',
      SWEEGO_API_KEY: 'sweego-test-key',
      SWEEGO_SMS_SENDER_ID: senderId,
    });

    expect(() => new ConfigService()).toThrow('config: SWEEGO_SMS_SENDER_ID');
  });

  it('requires an HTTPS Sweego endpoint', () => {
    process.env = baseEnvironment({ SWEEGO_API_URL: 'http://api.sweego.io/send' });

    expect(() => new ConfigService()).toThrow('config: SWEEGO_API_URL must be an absolute HTTPS URL');
  });

  it('caps the Sweego timeout at 30 seconds', () => {
    process.env = baseEnvironment({ SWEEGO_TIMEOUT: '31s' });

    expect(() => new ConfigService()).toThrow('config: SWEEGO_TIMEOUT must not exceed 30s');
  });

  it.each(['59s', '31m'])('rejects the out-of-range OTP duration %s', (ttl) => {
    process.env = baseEnvironment({ OTP_TTL: ttl });

    expect(() => new ConfigService()).toThrow('config: OTP_TTL must be between 1m and 30m');
  });

  it('rejects a non-French SMS region while phone delivery is France-only', () => {
    process.env = baseEnvironment({ SWEEGO_SMS_REGION: 'GB' });

    expect(() => new ConfigService()).toThrow('config: SWEEGO_SMS_REGION must be FR');
  });

  it('accepts an explicit list of web origins', () => {
    process.env = baseEnvironment({ CORS_ORIGINS: 'http://localhost:5173,https://admin.histae.test' });
    expect(new ConfigService().corsOrigins).toEqual(['http://localhost:5173', 'https://admin.histae.test']);
  });

  it('requires independent cryptographic keys', () => {
    process.env = baseEnvironment({ PHONE_HASH_KEY: 'e'.repeat(32) });
    expect(() => new ConfigService()).toThrow('config: JWT_SECRET, PHONE_ENCRYPTION_KEY, and PHONE_HASH_KEY must be distinct');

    process.env = baseEnvironment({ PHONE_ENCRYPTION_KEY: '61'.repeat(32), PHONE_HASH_KEY: 'a'.repeat(32) });
    expect(() => new ConfigService()).toThrow('config: JWT_SECRET, PHONE_ENCRYPTION_KEY, and PHONE_HASH_KEY must be distinct');
  });

  it.each(['59s', '61m'])('rejects the out-of-range access-token duration %s', (ttl) => {
    process.env = baseEnvironment({ JWT_ACCESS_TTL: ttl });
    expect(() => new ConfigService()).toThrow('config: JWT_ACCESS_TTL must be between 1m and 1h');
  });

  it.each(['15m', '4321h'])('rejects the unsafe refresh-token duration %s', (ttl) => {
    process.env = baseEnvironment({ JWT_REFRESH_TTL: ttl });
    expect(() => new ConfigService()).toThrow('config: JWT_REFRESH_TTL must be longer than JWT_ACCESS_TTL and no more than 4320h');
  });

  it('requires PostgreSQL TLS in production', () => {
    process.env = productionEnvironment({ POSTGRES_SSLMODE: 'disable' });
    expect(() => new ConfigService()).toThrow('config: production PostgreSQL requires TLS');
  });

  it('requires HTTPS origins in production', () => {
    process.env = productionEnvironment({ CORS_ORIGINS: 'http://admin.histae.test' });
    expect(() => new ConfigService()).toThrow('config: CORS_ORIGINS');
  });

  it('uses a localhost WebAuthn relying party in development', () => {
    expect(new ConfigService().adminAuth).toEqual(expect.objectContaining({
      origin: 'http://localhost:5173',
      rpId: 'localhost',
      cookieName: 'histae_admin_session',
      secureCookie: false,
      challengeTtlMillis: 300_000,
      sessionIdleTtlMillis: 1_800_000,
      sessionAbsoluteTtlMillis: 28_800_000,
    }));
  });

  it('requires a matching HTTPS WebAuthn origin and RP ID in production', () => {
    process.env = productionEnvironment({ ADMIN_WEBAUTHN_ORIGIN: '' });
    expect(() => new ConfigService()).toThrow('config: ADMIN_WEBAUTHN_ORIGIN');

    process.env = productionEnvironment({ ADMIN_WEBAUTHN_RP_ID: 'other.example.com' });
    expect(() => new ConfigService()).toThrow('config: ADMIN_WEBAUTHN_RP_ID');
  });

  it('rejects WebAuthn on an insecure non-local origin', () => {
    process.env = baseEnvironment({ ADMIN_WEBAUTHN_ORIGIN: 'http://admin.histae.test' });
    expect(() => new ConfigService()).toThrow('config: ADMIN_WEBAUTHN_ORIGIN');
  });

  it('accepts an explicit trusted-proxy IP and CIDR list', () => {
    process.env = baseEnvironment({ TRUST_PROXY: '127.0.0.1,10.0.0.0/8,2001:db8::/32' });
    expect(new ConfigService().trustProxy).toEqual(['127.0.0.1', '10.0.0.0/8', '2001:db8::/32']);
  });

  it('refuses globally trusted forwarding headers in production', () => {
    process.env = productionEnvironment({ TRUST_PROXY: 'true' });
    expect(() => new ConfigService()).toThrow('config: production TRUST_PROXY must list explicit proxy IP addresses or CIDR ranges');
  });

  it('accepts provider-neutral S3-compatible object storage settings', () => {
    process.env = baseEnvironment({
      OBJECT_STORAGE_ENDPOINT: 'http://127.0.0.1:8333',
      OBJECT_STORAGE_REGION: 'us-east-1',
      OBJECT_STORAGE_BUCKET: 'histae-test-photos',
      OBJECT_STORAGE_ACCESS_KEY: 'test-access',
      OBJECT_STORAGE_SECRET_KEY: 'test-secret',
      OBJECT_STORAGE_FORCE_PATH_STYLE: 'true',
    });

    expect(new ConfigService().objectStorage).toEqual({
      endpoint: 'http://127.0.0.1:8333/',
      region: 'us-east-1',
      bucket: 'histae-test-photos',
      accessKey: 'test-access',
      secretKey: 'test-secret',
      forcePathStyle: true,
    });
  });

  it('requires HTTPS object storage in production', () => {
    process.env = productionEnvironment({ OBJECT_STORAGE_ENDPOINT: 'http://storage.histae.test' });
    expect(() => new ConfigService()).toThrow('config: OBJECT_STORAGE_ENDPOINT must be an absolute HTTP(S) origin and HTTPS in production');
  });

  it('accepts the authenticated local photo moderation service and thresholds', () => {
    process.env = baseEnvironment({
      PHOTO_MODERATION_PROVIDER: 'local_http',
      PHOTO_MODERATION_ENDPOINT: 'http://127.0.0.1:8090',
      PHOTO_MODERATION_TOKEN: 'm'.repeat(32),
      PHOTO_MODERATION_MIN_SHARPNESS: '90.5',
      PHOTO_MODERATION_NSFW_REVIEW_THRESHOLD: '0.65',
    });
    expect(new ConfigService().photoModeration).toEqual({
      provider: 'local_http', endpoint: 'http://127.0.0.1:8090/', token: 'm'.repeat(32),
      timeoutMillis: 5_000, minSharpnessScore: 90.5, nsfwReviewThreshold: 0.65,
    });
  });

  it('requires a strong shared token and bounded photo moderation thresholds', () => {
    process.env = baseEnvironment({ PHOTO_MODERATION_PROVIDER: 'local_http', PHOTO_MODERATION_TOKEN: 'short' });
    expect(() => new ConfigService()).toThrow('config: PHOTO_MODERATION_TOKEN');
    process.env = baseEnvironment({ PHOTO_MODERATION_NSFW_REVIEW_THRESHOLD: '1.1' });
    expect(() => new ConfigService()).toThrow('config: invalid PHOTO_MODERATION_NSFW_REVIEW_THRESHOLD');
  });

  it.each(['59s', '31m'])('rejects the out-of-range account deletion token duration %s', (ttl) => {
    process.env = baseEnvironment({ ACCOUNT_DELETION_TOKEN_TTL: ttl });

    expect(() => new ConfigService()).toThrow('config: ACCOUNT_DELETION_TOKEN_TTL must be between 1m and 30m');
  });

  it('requires all Firebase service-account fields when FCM is enabled', () => {
    process.env = baseEnvironment({ PUSH_PROVIDER: 'fcm', FIREBASE_PROJECT_ID: 'histae-test' });

    expect(() => new ConfigService()).toThrow('config: Firebase project ID, client email, and private key are required');
  });

  it('accepts an explicit FCM configuration', () => {
    process.env = baseEnvironment({
      PUSH_PROVIDER: 'fcm',
      FIREBASE_PROJECT_ID: 'histae-test',
      FIREBASE_CLIENT_EMAIL: 'firebase-admin@histae-test.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY: 'test-private-key',
    });

    expect(new ConfigService().push).toEqual(expect.objectContaining({
      provider: 'fcm',
      projectId: 'histae-test',
      timeoutMillis: 5_000,
    }));
  });

  it('caps the push provider timeout at 30 seconds', () => {
    process.env = baseEnvironment({ PUSH_TIMEOUT: '31s' });

    expect(() => new ConfigService()).toThrow('config: PUSH_TIMEOUT must not exceed 30s');
  });

  it('accepts a complete Stripe test configuration and preserves the Checkout placeholder', () => {
    process.env = baseEnvironment(stripeEnvironment());

    expect(new ConfigService().billing).toEqual(expect.objectContaining({
      provider: 'stripe',
      premiumProductId: 'prod_histaePremium',
      premiumMonthlyPriceId: 'price_histaeMonthly',
      premiumAnnualPriceId: 'price_histaeAnnual',
      checkoutSuccessUrl: 'https://app.histae.test/billing/success?session_id={CHECKOUT_SESSION_ID}',
      timeoutMillis: 10_000,
      maxNetworkRetries: 2,
    }));
  });

  it('requires Stripe identifiers, signed webhook secret, and HTTPS return URLs when enabled', () => {
    process.env = baseEnvironment({ ...stripeEnvironment(), STRIPE_WEBHOOK_SECRET: '' });
    expect(() => new ConfigService()).toThrow('config: STRIPE_WEBHOOK_SECRET');

    process.env = baseEnvironment({ ...stripeEnvironment(), STRIPE_CHECKOUT_CANCEL_URL: 'http://app.histae.test/cancel' });
    expect(() => new ConfigService()).toThrow('config: STRIPE_CHECKOUT_CANCEL_URL');
  });

  it('does not allow a live Stripe key outside production', () => {
    process.env = baseEnvironment({ ...stripeEnvironment(), STRIPE_SECRET_KEY: 'sk_live_histaeSecret' });
    expect(() => new ConfigService()).toThrow('config: non-production environments require a Stripe test secret key');
  });
});

function baseEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ENV: 'test',
    JWT_SECRET: 'j'.repeat(32),
    PHONE_ENCRYPTION_KEY: 'e'.repeat(32),
    PHONE_HASH_KEY: 'h'.repeat(32),
    POSTGRES_HOST: 'localhost',
    POSTGRES_USER: 'postgres',
    POSTGRES_PASSWORD: 'test-password',
    POSTGRES_DB: 'histae-test',
    RATE_LIMIT_STORE: 'memory',
    SMS_PROVIDER: 'disabled',
    SWEEGO_API_URL: 'https://api.sweego.io/send',
    SWEEGO_SMS_REGION: 'FR',
    SWEEGO_TIMEOUT: '10s',
    OTP_TTL: '10m',
    ...overrides,
  };
}

function productionEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return baseEnvironment({
    ENV: 'production',
    POSTGRES_SSLMODE: 'require',
    SCYLLA_ENABLED: 'true',
    SCYLLA_TLS: 'true',
    SCYLLA_USERNAME: 'histae',
    SCYLLA_PASSWORD: 'test-password',
    SCYLLA_REPLICATION_FACTOR: '3',
    RATE_LIMIT_STORE: 'redis',
    REDIS_ADDR: 'localhost:6379',
    REDIS_TLS: 'true',
    REDIS_PASSWORD: 'test-password',
    OBJECT_STORAGE_ENDPOINT: 'https://storage.histae.test',
    OBJECT_STORAGE_ACCESS_KEY: 'test-object-access',
    OBJECT_STORAGE_SECRET_KEY: 'test-object-secret',
    SMS_PROVIDER: 'sweego',
    SWEEGO_API_KEY: 'sweego-test-key',
    SWEEGO_SMS_SENDER_ID: 'Histae',
    TERMS_OF_SERVICE_VERSION: 'v1',
    TERMS_OF_SERVICE_URL: 'https://example.com/terms',
    PRIVACY_POLICY_VERSION: 'v1',
    PRIVACY_POLICY_URL: 'https://example.com/privacy',
    SENSITIVE_DATA_CONSENT_VERSION: 'v1',
    SENSITIVE_DATA_CONSENT_URL: 'https://example.com/sensitive-data',
    LOCATION_CONSENT_VERSION: 'v1',
    LOCATION_CONSENT_URL: 'https://example.com/location',
    LEGAL_REVIEW_REFERENCE: 'test-review',
    ADMIN_WEBAUTHN_ORIGIN: 'https://admin.histae.test',
    ADMIN_WEBAUTHN_RP_ID: 'admin.histae.test',
    ...stripeEnvironment({ STRIPE_SECRET_KEY: 'sk_live_histaeSecret' }),
    ...overrides,
  });
}

function stripeEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    BILLING_PROVIDER: 'stripe',
    STRIPE_SECRET_KEY: 'sk_test_histaeSecret',
    STRIPE_WEBHOOK_SECRET: 'whsec_histaeWebhookSecret',
    STRIPE_PREMIUM_PRODUCT_ID: 'prod_histaePremium',
    STRIPE_PREMIUM_MONTHLY_PRICE_ID: 'price_histaeMonthly',
    STRIPE_PREMIUM_ANNUAL_PRICE_ID: 'price_histaeAnnual',
    STRIPE_CHECKOUT_SUCCESS_URL: 'https://app.histae.test/billing/success?session_id={CHECKOUT_SESSION_ID}',
    STRIPE_CHECKOUT_CANCEL_URL: 'https://app.histae.test/billing/cancel',
    STRIPE_PORTAL_RETURN_URL: 'https://app.histae.test/settings/subscription',
    ...overrides,
  };
}
