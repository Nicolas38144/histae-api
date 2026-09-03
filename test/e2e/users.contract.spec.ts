import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { JwtActiveGuard } from '../../src/auth/auth.guard';
import type { AuthenticatedRequest } from '../../src/auth/auth.types';
import { ApiExceptionFilter } from '../../src/common/api-exception.filter';
import { PlansController } from '../../src/plans/plans.controller';
import { PlansService } from '../../src/plans/plans.service';
import { TraitsController } from '../../src/traits/traits.controller';
import { TraitsService } from '../../src/traits/traits.service';
import { UsersController } from '../../src/users/users.controller';
import { UsersService } from '../../src/users/users.service';
import { RateLimitService } from '../../src/ratelimit/rate-limit.service';
import { ConfigService } from '../../src/config/config.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TRAIT_ID = '22222222-2222-4222-8222-222222222222';
const DELETION_TOKEN = `33333333-3333-4333-8333-333333333333:${'a'.repeat(43)}`;
const PHOTO_IDEMPOTENCY_KEY = '44444444-4444-4444-8444-444444444444';

describe('Users HTTP contract', () => {
  let app: NestFastifyApplication;
  const profile = {
    user_id: USER_ID,
    firstname: 'Alice',
    birthdate: '1995-04-12',
    sex: 'female',
    bio: 'Curieuse et voyageuse.',
    photo: 'https://cdn.example.test/alice.jpg',
  };
  const preferences = {
    user_id: USER_ID,
    min_age: 25,
    max_age: 40,
    max_distance_km: 30,
    looking_for: 'both',
  };
  const consentState = {
    consents: [{
      consent_type: 'terms_of_service_acceptance',
      granted: true,
      document_version: '2026-08',
      required_document_version: '2026-08',
      document_url: 'https://histae.example.test/terms',
      updated_at: new Date('2030-01-01T00:00:00.000Z'),
    }],
    onboarding_complete: true,
    required_actions: [],
  };
  const trait = { id: TRAIT_ID, name: 'Curieux' };
  const users = {
    getProfile: jest.fn().mockResolvedValue(profile),
    getConsents: jest.fn().mockResolvedValue(consentState),
    updateConsents: jest.fn().mockResolvedValue(consentState),
    updateProfile: jest.fn().mockResolvedValue(undefined),
    uploadPhoto: jest.fn().mockResolvedValue({
      photo: 'https://storage.example.test/signed-photo.webp',
      moderation_status: 'pending',
      moderation_reasons: ['analysis_unavailable'],
    }),
    deletePhoto: jest.fn().mockResolvedValue(undefined),
    getPreferences: jest.fn().mockResolvedValue(preferences),
    updatePreferences: jest.fn().mockResolvedValue(undefined),
    updatePresence: jest.fn().mockResolvedValue(undefined),
    issueDeletionToken: jest.fn().mockResolvedValue({
      confirmation_token: DELETION_TOKEN,
      expires_at: new Date('2030-01-01T00:10:00.000Z'),
    }),
    confirmAnonymize: jest.fn().mockResolvedValue(undefined),
  };
  const traits = {
    list: jest.fn().mockResolvedValue([trait]),
    listForUser: jest.fn().mockResolvedValue([trait]),
    addToUser: jest.fn().mockResolvedValue(undefined),
    removeFromUser: jest.fn().mockResolvedValue(undefined),
  };
  const plans = {
    list: jest.fn().mockResolvedValue([{
      code: 'free',
      display_name: 'Free',
      monthly_price_cents: 0,
      annual_price_cents: 0,
      currency: 'EUR',
      trial_days: 0,
      weekly_continuation_limit: 3,
      features: [],
    }]),
  };
  const limits = { enforce: jest.fn().mockResolvedValue(undefined) };
  const config = { rateLimit: { photo: { max: 10, windowMs: 3_600_000 } } };
  const activeGuard: CanActivate = {
    canActivate(context: ExecutionContext): boolean {
      const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
      request.auth = {
        userId: USER_ID,
        account: { user_id: USER_ID, role: 'user', is_banned: false, onboarding_complete: true },
      };
      return true;
    },
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [UsersController, TraitsController, PlansController],
      providers: [
        { provide: UsersService, useValue: users },
        { provide: TraitsService, useValue: traits },
        { provide: PlansService, useValue: plans },
        { provide: RateLimitService, useValue: limits },
        { provide: ConfigService, useValue: config },
      ],
    }).overrideGuard(JwtActiveGuard).useValue(activeGuard).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(multipart, { limits: { fileSize: 500_000, files: 1, fields: 0, parts: 1 } });
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
  });

  afterAll(async () => app?.close());

  beforeEach(() => jest.clearAllMocks());

  it('returns the authenticated profile and discovery preferences', async () => {
    const profileResponse = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/api/users/me' });
    const preferencesResponse = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/api/users/me/preferences' });

    expect(profileResponse.statusCode).toBe(200);
    expect(profileResponse.json()).toEqual(profile);
    expect(preferencesResponse.statusCode).toBe(200);
    expect(preferencesResponse.json()).toEqual(preferences);
    expect(users.getProfile).toHaveBeenCalledWith(USER_ID);
    expect(users.getPreferences).toHaveBeenCalledWith(USER_ID);
  });

  it('returns and updates legal choices with request audit metadata', async () => {
    const current = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/api/users/me/consents' });
    const updated = await app.getHttpAdapter().getInstance().inject({
      method: 'PUT',
      url: '/api/users/me/consents',
      headers: { 'user-agent': 'Histae/1.0 (Flutter)' },
      payload: { consents: [{ consent_type: 'terms_of_service_acceptance', granted: true }] },
    });

    expect(current.statusCode).toBe(200);
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({
      ...consentState,
      consents: [{ ...consentState.consents[0], updated_at: '2030-01-01T00:00:00.000Z' }],
    });
    expect(users.updateConsents).toHaveBeenCalledWith(
      USER_ID,
      [{ consent_type: 'terms_of_service_acceptance', granted: true }],
      '127.0.0.1',
      'Histae/1.0 (Flutter)',
    );
  });

  it('rejects malformed legal choices before the service', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'PUT',
      url: '/api/users/me/consents',
      payload: { consents: [{ consent_type: 'advertising', granted: 'yes' }] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: {
      code: 'invalid_consent_payload',
      message: 'The consent request body is invalid.',
    } });
    expect(users.updateConsents).not.toHaveBeenCalled();
  });

  it('updates the profile using only the public mobile fields', async () => {
    const payload = {
      firstname: 'Alice',
      birthdate: '1995-04-12',
      sex: 'female',
      bio: 'Curieuse et voyageuse.',
    };
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'PATCH',
      url: '/api/users/me/profile',
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: 'profile updated' });
    expect(users.updateProfile).toHaveBeenCalledWith(USER_ID, payload);
  });

  it('uploads and deletes the private profile photo through dedicated routes', async () => {
    const multipartRequest = multipartPhoto('portrait.webp', 'image/webp', Buffer.from('webp fixture'));
    const uploaded = await app.getHttpAdapter().getInstance().inject({
      method: 'PUT',
      url: '/api/users/me/photo',
      headers: {
        ...multipartRequest.headers,
        'idempotency-key': PHOTO_IDEMPOTENCY_KEY,
      },
      payload: multipartRequest.payload,
    });
    const deleted = await app.getHttpAdapter().getInstance().inject({ method: 'DELETE', url: '/api/users/me/photo' });

    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json()).toEqual({
      message: 'photo updated',
      photo: 'https://storage.example.test/signed-photo.webp',
      moderation_status: 'pending',
      moderation_reasons: ['analysis_unavailable'],
    });
    expect(users.uploadPhoto).toHaveBeenCalledWith(USER_ID, {
      filename: 'portrait.webp',
      mimetype: 'image/webp',
      body: Buffer.from('webp fixture'),
    }, PHOTO_IDEMPOTENCY_KEY);
    expect(limits.enforce).toHaveBeenCalledWith(
      'photo', USER_ID, config.rateLimit.photo, 'photo_rate_limit_exceeded',
    );
    expect(deleted.statusCode).toBe(204);
    expect(users.deletePhoto).toHaveBeenCalledWith(USER_ID);
  });

  it('rejects a photo upload larger than 500,000 bytes', async () => {
    const multipartRequest = multipartPhoto('portrait.jpg', 'image/jpeg', Buffer.alloc(500_001));
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'PUT',
      url: '/api/users/me/photo',
      headers: {
        ...multipartRequest.headers,
        'idempotency-key': PHOTO_IDEMPOTENCY_KEY,
      },
      payload: multipartRequest.payload,
    });

    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('photo_too_large');
    expect(users.uploadPhoto).not.toHaveBeenCalled();
  });

  it('requires a UUID v4 Idempotency-Key before reading the photo', async () => {
    const multipartRequest = multipartPhoto(
      'portrait.webp',
      'image/webp',
      Buffer.from('webp fixture'),
    );
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'PUT',
      url: '/api/users/me/photo',
      headers: multipartRequest.headers,
      payload: multipartRequest.payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_idempotency_key');
    expect(limits.enforce).not.toHaveBeenCalled();
    expect(users.uploadPhoto).not.toHaveBeenCalled();
  });

  it('rejects privilege fields in profile updates', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'PATCH',
      url: '/api/users/me/profile',
      payload: { firstname: 'Alice', birthdate: '1995-04-12', role: 'admin' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_profile_payload');
    expect(users.updateProfile).not.toHaveBeenCalled();
  });

  it('updates discovery preferences and the current presence', async () => {
    const preferencePayload = { min_age: 25, max_age: 40, max_distance_km: 30, looking_for: 'both' };
    const presencePayload = { latitude: 48.8566, longitude: 2.3522 };
    const preferenceResponse = await app.getHttpAdapter().getInstance().inject({
      method: 'PATCH', url: '/api/users/me/preferences', payload: preferencePayload,
    });
    const presenceResponse = await app.getHttpAdapter().getInstance().inject({
      method: 'PATCH', url: '/api/users/me/presence', payload: presencePayload,
    });

    expect(preferenceResponse.statusCode).toBe(200);
    expect(preferenceResponse.json()).toEqual({ message: 'preferences updated' });
    expect(presenceResponse.statusCode).toBe(200);
    expect(presenceResponse.json()).toEqual({ message: 'presence updated' });
    expect(users.updatePreferences).toHaveBeenCalledWith(USER_ID, preferencePayload);
    expect(users.updatePresence).toHaveBeenCalledWith(USER_ID, presencePayload);
  });

  it('issues and consumes the dedicated account deletion token', async () => {
    const issued = await app.getHttpAdapter().getInstance().inject({ method: 'POST', url: '/api/users/me/deletion-token' });
    const deleted = await app.getHttpAdapter().getInstance().inject({
      method: 'DELETE', url: '/api/users/me', payload: { confirmation_token: DELETION_TOKEN },
    });

    expect(issued.statusCode).toBe(201);
    expect(issued.json()).toEqual({ confirmation_token: DELETION_TOKEN, expires_at: '2030-01-01T00:10:00.000Z' });
    expect(deleted.statusCode).toBe(204);
    expect(users.issueDeletionToken).toHaveBeenCalledWith(USER_ID);
    expect(users.confirmAnonymize).toHaveBeenCalledWith(USER_ID, DELETION_TOKEN);
  });

  it('rejects malformed account deletion tokens before erasure', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'DELETE', url: '/api/users/me', payload: { confirmation_token: 'delete-me' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_account_deletion_payload');
    expect(users.confirmAnonymize).not.toHaveBeenCalled();
  });

  it('lists, adds, and removes traits for the authenticated account', async () => {
    const available = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/api/traits' });
    const mine = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/api/users/me/traits' });
    const added = await app.getHttpAdapter().getInstance().inject({
      method: 'POST', url: '/api/users/me/traits', payload: { traitId: TRAIT_ID },
    });
    const removed = await app.getHttpAdapter().getInstance().inject({
      method: 'DELETE', url: `/api/users/me/traits/${TRAIT_ID}`,
    });

    expect(available.statusCode).toBe(200);
    expect(available.json()).toEqual({ traits: [trait] });
    expect(mine.json()).toEqual({ traits: [trait] });
    expect(added.statusCode).toBe(204);
    expect(removed.statusCode).toBe(204);
    expect(traits.addToUser).toHaveBeenCalledWith(USER_ID, TRAIT_ID);
    expect(traits.removeFromUser).toHaveBeenCalledWith(USER_ID, TRAIT_ID);
  });

  it('rejects invalid trait identifiers before mutation', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST', url: '/api/users/me/traits', payload: { traitId: 'not-a-uuid' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_user_trait_payload');
    expect(traits.addToUser).not.toHaveBeenCalled();
  });

  it('exposes the public plans without requiring a mobile session', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/api/plans' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ plans: await plans.list.mock.results[0].value });
    expect(plans.list).toHaveBeenCalledTimes(1);
  });
});

function multipartPhoto(filename: string, mimetype: string, content: Buffer): {
  headers: Record<string, string>;
  payload: Buffer;
} {
  const boundary = '----histae-photo-contract-boundary';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${filename}"\r\nContent-Type: ${mimetype}\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}
