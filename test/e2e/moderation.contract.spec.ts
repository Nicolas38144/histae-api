import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AdminSessionGuard } from '../../src/admin-auth/admin-auth.guard';
import type { AuthenticatedRequest } from '../../src/auth/auth.types';
import { ApiExceptionFilter } from '../../src/common/api-exception.filter';
import { ModerationController } from '../../src/moderation/moderation.controller';
import { ModerationService } from '../../src/moderation/moderation.service';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const CASE_ID = '22222222-2222-4222-8222-222222222222';

describe('Content moderation HTTP contract', () => {
  let app: NestFastifyApplication;
  const moderation = {
    list: jest.fn().mockResolvedValue({ items: [{ case_id: CASE_ID, content_type: 'photo', status: 'pending' }], next_cursor: null }),
    detail: jest.fn().mockResolvedValue({ case_id: CASE_ID, content_type: 'photo', status: 'pending', photo: 'https://storage.test/photo' }),
    review: jest.fn().mockResolvedValue(undefined),
  };
  const activeGuard: CanActivate = {
    canActivate(context: ExecutionContext): boolean {
      const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
      request.auth = { userId: ADMIN_ID, account: {
        user_id: ADMIN_ID, role: 'admin', is_banned: false, onboarding_complete: true,
      } };
      return true;
    },
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ModerationController],
      providers: [{ provide: ModerationService, useValue: moderation }],
    }).overrideGuard(AdminSessionGuard).useValue(activeGuard).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
  });

  afterAll(async () => app?.close());
  beforeEach(() => jest.clearAllMocks());

  it('lists metadata without requiring access to the content', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET', url: '/api/admin/content-moderation?status=pending&content_type=photo&limit=20',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cases: [expect.objectContaining({ case_id: CASE_ID })], next_cursor: null });
    expect(moderation.list).toHaveBeenCalledWith('pending', 'photo', 20, 0, undefined);
  });

  it('requires an audit reason to reveal content', async () => {
    const rejected = await app.getHttpAdapter().getInstance().inject({
      method: 'GET', url: `/api/admin/content-moderation/${CASE_ID}?reason=x`,
    });
    const accepted = await app.getHttpAdapter().getInstance().inject({
      method: 'GET', url: `/api/admin/content-moderation/${CASE_ID}?reason=Revue%20du%20contenu`,
    });
    expect(rejected.statusCode).toBe(400);
    expect(accepted.statusCode).toBe(200);
    expect(moderation.detail).toHaveBeenCalledWith(CASE_ID, ADMIN_ID, 'admin', 'Revue du contenu');
  });

  it('validates the optimistic version and complete photo checklist', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'PATCH', url: `/api/admin/content-moderation/${CASE_ID}`,
      payload: {
        version: 3,
        decision: 'approved',
        reason: 'Photo conforme après revue',
        photo_checks: { face_detectable: true, sharp_enough: true, content_allowed: true },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(moderation.review).toHaveBeenCalledWith(
      CASE_ID, 3, 'approved', 'Photo conforme après revue',
      { face_detectable: true, sharp_enough: true, content_allowed: true }, ADMIN_ID, 'admin',
    );
  });

  it('rejects unknown fields and unsupported decisions', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'PATCH', url: `/api/admin/content-moderation/${CASE_ID}`,
      payload: { version: 1, decision: 'deleted', reason: 'Décision invalide', unexpected: true },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_moderation_request');
    expect(moderation.review).not.toHaveBeenCalled();
  });
});
