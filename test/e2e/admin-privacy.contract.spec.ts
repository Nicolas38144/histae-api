import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AdminSessionGuard } from '../../src/admin-auth/admin-auth.guard';
import type { AuthenticatedRequest } from '../../src/auth/auth.types';
import { ApiExceptionFilter } from '../../src/common/api-exception.filter';
import { ConfigService } from '../../src/config/config.service';
import { AdminPrivacyController } from '../../src/privacy/privacy.controller';
import { PrivacyService } from '../../src/privacy/privacy.service';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const REQUEST = '22222222-2222-4222-8222-222222222222';

describe('Administrator resumable erasure HTTP contract', () => {
  let app: NestFastifyApplication;
  let authenticatedAt: Date;
  const erasure = { step: 'scylla', scylla_partition: 32, status: 'pending', event_id: REQUEST, attempts: 0, last_error_code: null };
  const privacy = {
    requestsForAdmin: jest.fn().mockResolvedValue([{ id: REQUEST, status: 'in_progress', erasure }]),
    updateRequest: jest.fn().mockResolvedValue('erasure_scheduled'),
  };
  const sessionGuard: CanActivate = {
    canActivate(context: ExecutionContext): boolean {
      const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
      request.auth = {
        userId: ADMIN,
        account: { user_id: ADMIN, role: 'admin', is_banned: false, onboarding_complete: true },
        adminSession: { authenticatedAt } as NonNullable<AuthenticatedRequest['auth']>['adminSession'],
      };
      return true;
    },
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AdminPrivacyController],
      providers: [
        { provide: PrivacyService, useValue: privacy },
        { provide: ConfigService, useValue: { adminAuth: { recentAuthenticationMillis: 300_000 } } },
      ],
    }).overrideGuard(AdminSessionGuard).useValue(sessionGuard).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
  });
  afterAll(async () => app?.close());
  beforeEach(() => { jest.clearAllMocks(); authenticatedAt = new Date(); });

  it('acknowledges scheduling without reporting that erasure has already completed', async () => {
    const response = await app.inject({ method: 'PATCH', url: `/api/admin/data-subject-requests/${REQUEST}`, payload: { status: 'completed', notes: 'Identity verified' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: 'account erasure scheduled' });
    expect(privacy.updateRequest).toHaveBeenCalledWith(REQUEST, 'completed', ADMIN, 'admin', 'Identity verified');
  });

  it('requires recent WebAuthn authentication for a transition', async () => {
    authenticatedAt = new Date(Date.now() - 600_000);
    const response = await app.inject({ method: 'PATCH', url: `/api/admin/data-subject-requests/${REQUEST}`, payload: { status: 'completed' } });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('admin_reauthentication_required');
    expect(privacy.updateRequest).not.toHaveBeenCalled();
  });

  it('exposes progress while keeping provider payloads out of the contract', async () => {
    authenticatedAt = new Date(0);
    const response = await app.inject({ method: 'GET', url: '/api/admin/data-subject-requests?status=in_progress' });
    expect(response.statusCode).toBe(200);
    expect(response.json().requests[0].erasure).toEqual(erasure);
    expect(response.body).not.toMatch(/object_key|stripe_customer|payload|token/);
  });

  it('rejects caller-selected progress and provider identifiers', async () => {
    const response = await app.inject({ method: 'PATCH', url: `/api/admin/data-subject-requests/${REQUEST}`, payload: { status: 'completed', step: 'completed', stripe_customer_id: 'cus_Injected' } });
    expect(response.statusCode).toBe(400);
    expect(privacy.updateRequest).not.toHaveBeenCalled();
  });
});
