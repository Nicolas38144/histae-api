import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AdminAuthController } from '../../src/admin-auth/admin-auth.controller';
import { AdminSessionGuard, RecentAdminAuthenticationGuard } from '../../src/admin-auth/admin-auth.guard';
import { AdminAuthService } from '../../src/admin-auth/admin-auth.service';
import type { AuthenticatedRequest } from '../../src/auth/auth.types';
import { ApiExceptionFilter } from '../../src/common/api-exception.filter';
import { ConfigService } from '../../src/config/config.service';
import { RateLimitService } from '../../src/ratelimit/rate-limit.service';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const CREDENTIAL_ID = '33333333-3333-4333-8333-333333333333';
const CHALLENGE_ID = '44444444-4444-4444-8444-444444444444';
const SESSION_TOKEN = 'a'.repeat(43);
const BOOTSTRAP_TOKEN = `55555555-5555-4555-8555-555555555555:${'b'.repeat(43)}`;
const authenticatedAt = new Date('2030-01-01T12:00:00.000Z');
const expiresAt = new Date('2030-01-01T12:30:00.000Z');

describe('Native administrator WebAuthn HTTP contract', () => {
  let app: NestFastifyApplication;
  const session = {
    user_id: ADMIN_ID,
    role: 'admin' as const,
    authenticated_at: authenticatedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  };
  const auth = {
    authenticationOptions: jest.fn().mockResolvedValue({
      challenge_id: CHALLENGE_ID,
      options: { challenge: 'authentication-challenge', rpId: 'localhost', userVerification: 'required' },
    }),
    authenticate: jest.fn().mockResolvedValue({ token: SESSION_TOKEN, session }),
    bootstrapRegistrationOptions: jest.fn().mockResolvedValue({
      challenge_id: CHALLENGE_ID,
      options: { challenge: 'registration-challenge', rp: { id: 'localhost', name: 'Histae Administration' } },
    }),
    completeBootstrapRegistration: jest.fn().mockResolvedValue({ token: SESSION_TOKEN, session }),
    credentials: jest.fn().mockResolvedValue([{ id: CREDENTIAL_ID, name: 'Clé principale', current: true }]),
    additionalRegistrationOptions: jest.fn().mockResolvedValue({ challenge_id: CHALLENGE_ID, options: {} }),
    addCredential: jest.fn().mockResolvedValue(undefined),
    revokeCredential: jest.fn().mockResolvedValue(undefined),
    revokeOtherSessions: jest.fn().mockResolvedValue(2),
    revokeSession: jest.fn().mockResolvedValue(undefined),
  };
  const limits = { enforce: jest.fn().mockResolvedValue(undefined) };
  const config = {
    adminAuth: {
      cookieName: 'histae_admin_session',
      secureCookie: false,
      sessionAbsoluteTtlMillis: 28_800_000,
    },
    rateLimit: { adminAuth: { max: 10, windowMs: 300_000 } },
  };
  const activeGuard: CanActivate = {
    canActivate(context: ExecutionContext): boolean {
      const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
      request.auth = {
        userId: ADMIN_ID,
        account: {
          user_id: ADMIN_ID,
          role: 'admin',
          is_banned: false,
          onboarding_complete: true,
        },
        adminSession: {
          id: SESSION_ID,
          credentialId: CREDENTIAL_ID,
          authenticatedAt,
          expiresAt,
        },
      };
      return true;
    },
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AdminAuthController],
      providers: [
        { provide: AdminAuthService, useValue: auth },
        { provide: RateLimitService, useValue: limits },
        { provide: ConfigService, useValue: config },
      ],
    })
      .overrideGuard(AdminSessionGuard).useValue(activeGuard)
      .overrideGuard(RecentAdminAuthenticationGuard).useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
  });

  afterAll(async () => app?.close());
  beforeEach(() => jest.clearAllMocks());

  it('creates username-less authentication options under the dedicated rate limit', async () => {
    const response = await inject({ method: 'POST', url: '/api/admin/auth/login/options' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ challenge_id: CHALLENGE_ID }));
    expect(limits.enforce).toHaveBeenCalledWith(
      'admin-auth', expect.any(String), config.rateLimit.adminAuth, 'admin_auth_rate_limit_exceeded',
    );
  });

  it('sets an HttpOnly strict localhost cookie without exposing its token', async () => {
    const response = await inject({
      method: 'POST',
      url: '/api/admin/auth/login/verify',
      payload: { challenge_id: CHALLENGE_ID, credential: {} },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(session);
    expect(response.body).not.toContain(SESSION_TOKEN);
    const cookie = response.headers['set-cookie'];
    expect(cookie).toContain(`histae_admin_session=${SESSION_TOKEN}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain('Secure');
  });

  it('registers the first passkey from a one-use bootstrap token', async () => {
    const options = await inject({
      method: 'POST',
      url: '/api/admin/auth/bootstrap/options',
      payload: { bootstrap_token: BOOTSTRAP_TOKEN },
    });
    const verified = await inject({
      method: 'POST',
      url: '/api/admin/auth/bootstrap/verify',
      payload: {
        bootstrap_token: BOOTSTRAP_TOKEN,
        challenge_id: CHALLENGE_ID,
        credential: {},
        name: 'Clé principale',
      },
    });

    expect(options.statusCode).toBe(200);
    expect(verified.statusCode).toBe(201);
    expect(auth.completeBootstrapRegistration).toHaveBeenCalledWith(expect.objectContaining({
      token: BOOTSTRAP_TOKEN,
      name: 'Clé principale',
    }));
  });

  it('returns the server-side session and manages credentials without bearer tokens', async () => {
    const current = await inject({ method: 'GET', url: '/api/admin/auth/session' });
    const credentials = await inject({ method: 'GET', url: '/api/admin/auth/credentials' });
    const revoked = await inject({
      method: 'DELETE', url: `/api/admin/auth/credentials/${CREDENTIAL_ID}`,
    });

    expect(current.statusCode).toBe(200);
    expect(current.json()).toEqual(session);
    expect(credentials.statusCode).toBe(200);
    expect(credentials.json()).toEqual([expect.objectContaining({ id: CREDENTIAL_ID, current: true })]);
    expect(revoked.statusCode).toBe(204);
    expect(auth.revokeCredential).toHaveBeenCalledWith(ADMIN_ID, CREDENTIAL_ID, SESSION_ID, CREDENTIAL_ID);
  });

  it('rejects unknown authentication fields before invoking the service', async () => {
    const response = await inject({
      method: 'POST',
      url: '/api/admin/auth/login/verify',
      payload: { challenge_id: CHALLENGE_ID, credential: {}, unexpected: true },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe('invalid_admin_auth_request');
    expect(auth.authenticate).not.toHaveBeenCalled();
  });

  it('revokes the current session and expires the cookie on logout', async () => {
    const response = await inject({ method: 'POST', url: '/api/admin/auth/logout' });

    expect(response.statusCode).toBe(204);
    expect(auth.revokeSession).toHaveBeenCalledWith(ADMIN_ID, SESSION_ID);
    expect(response.headers['set-cookie']).toContain('Max-Age=0');
  });

  function inject(input: {
    method: 'GET' | 'POST' | 'DELETE';
    url: string;
    payload?: Record<string, unknown>;
  }): Promise<{
    statusCode: number;
    body: string;
    headers: Record<string, string | string[] | number | undefined>;
    json(): unknown;
  }> {
    return app.getHttpAdapter().getInstance().inject(input);
  }
});
