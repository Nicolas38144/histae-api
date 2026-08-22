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

  it('requires HTTPS origins in production', () => {
    process.env = productionEnvironment({ CORS_ORIGINS: 'http://admin.histae.test' });
    expect(() => new ConfigService()).toThrow('config: CORS_ORIGINS');
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
    SCYLLA_ENABLED: 'true',
    SCYLLA_TLS: 'true',
    SCYLLA_USERNAME: 'histae',
    SCYLLA_PASSWORD: 'test-password',
    SCYLLA_REPLICATION_FACTOR: '3',
    RATE_LIMIT_STORE: 'redis',
    REDIS_ADDR: 'localhost:6379',
    REDIS_TLS: 'true',
    REDIS_PASSWORD: 'test-password',
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
    ...overrides,
  });
}
