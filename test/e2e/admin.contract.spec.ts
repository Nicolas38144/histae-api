import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { AdminController } from '../../src/admin/admin.controller';
import { AdminService } from '../../src/admin/admin.service';
import { AdminGuard, JwtActiveGuard } from '../../src/auth/auth.guard';
import type { AuthenticatedRequest } from '../../src/auth/auth.types';
import { ApiExceptionFilter } from '../../src/common/api-exception.filter';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const PHOTO_ID = '22222222-2222-4222-8222-222222222222';

describe('Admin photo reconciliation HTTP contract', () => {
  let app: NestFastifyApplication;
  const admin = {
    photoReconciliation: jest.fn().mockResolvedValue({
      items: [{
        photo_id: PHOTO_ID,
        user_id: '33333333-3333-4333-8333-333333333333',
        status: 'deleting',
        issue: 'deletion_dead_letter',
      }],
      next_cursor: null,
    }),
    reconcilePhoto: jest.fn().mockResolvedValue(undefined),
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
      };
      return true;
    },
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [{ provide: AdminService, useValue: admin }],
    })
      .overrideGuard(JwtActiveGuard)
      .useValue(activeGuard)
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
  });

  afterAll(async () => app?.close());

  beforeEach(() => jest.clearAllMocks());

  it('lists a validated, paginated reconciliation queue', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/api/admin/photo-reconciliation?status=dead_letter&limit=20',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      photos: [expect.objectContaining({
        photo_id: PHOTO_ID,
        issue: 'deletion_dead_letter',
      })],
      next_cursor: null,
    });
    expect(admin.photoReconciliation).toHaveBeenCalledWith(
      'dead_letter', 20, 0, undefined,
    );
  });

  it('queues a reconciliation with the authenticated administrator identity', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: `/api/admin/photo-reconciliation/${PHOTO_ID}/retry`,
      payload: { reason: 'Incident stockage confirmé' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ message: 'photo reconciliation queued' });
    expect(admin.reconcilePhoto).toHaveBeenCalledWith(
      PHOTO_ID,
      'Incident stockage confirmé',
      ADMIN_ID,
      'admin',
    );
  });

  it('rejects unknown filters before querying the service', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/api/admin/photo-reconciliation?status=ready',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_admin_request');
    expect(admin.photoReconciliation).not.toHaveBeenCalled();
  });

  it('rejects malformed photo IDs and empty audit reasons', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/api/admin/photo-reconciliation/not-a-uuid/retry',
      payload: { reason: ' ' },
    });

    expect(response.statusCode).toBe(400);
    expect(admin.reconcilePhoto).not.toHaveBeenCalled();
  });
});
