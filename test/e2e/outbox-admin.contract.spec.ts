import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AdminSessionGuard, RecentAdminAuthenticationGuard } from '../../src/admin-auth/admin-auth.guard';
import type { AuthenticatedRequest } from '../../src/auth/auth.types';
import { ApiExceptionFilter } from '../../src/common/api-exception.filter';
import { OutboxAdminController } from '../../src/outbox/outbox-admin.controller';
import { OutboxAdminService } from '../../src/outbox/outbox-admin.service';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';

describe('Administrator dead-letter HTTP contract', () => {
  let app: NestFastifyApplication;
  const outbox = {
    deadLetters: jest.fn().mockResolvedValue({
      items: [{ event_id: EVENT_ID, event_type: 'photo.delete', attempts: 10, last_error_code: 'handler_failed' }],
      next_cursor: null,
    }),
    retry: jest.fn().mockResolvedValue(undefined),
    discard: jest.fn().mockResolvedValue(undefined),
  };
  const activeGuard: CanActivate = {
    canActivate(context: ExecutionContext): boolean {
      const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
      request.auth = {
        userId: ADMIN_ID,
        account: { user_id: ADMIN_ID, role: 'admin', is_banned: false, onboarding_complete: true },
      };
      return true;
    },
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [OutboxAdminController],
      providers: [{ provide: OutboxAdminService, useValue: outbox }],
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

  it('lists a cursor-paginated queue without aggregate or payload', async () => {
    const response = await inject({ method: 'GET', url: '/api/admin/outbox/dead-letters?limit=20' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      events: [expect.objectContaining({ event_id: EVENT_ID, event_type: 'photo.delete' })],
      next_cursor: null,
    });
    expect(response.body).not.toContain('aggregate_id');
    expect(response.body).not.toContain('payload');
  });

  it('retries and discards with the authenticated operator identity and reason', async () => {
    const retried = await inject({
      method: 'POST', url: `/api/admin/outbox/${EVENT_ID}/retry`, payload: { reason: 'Stockage rétabli' },
    });
    const discarded = await inject({
      method: 'POST', url: `/api/admin/outbox/${EVENT_ID}/discard`, payload: { reason: 'Agrégat déjà absent' },
    });
    expect(retried.statusCode).toBe(202);
    expect(discarded.statusCode).toBe(204);
    expect(outbox.retry).toHaveBeenCalledWith(EVENT_ID, { userId: ADMIN_ID, role: 'admin' }, 'Stockage rétabli');
    expect(outbox.discard).toHaveBeenCalledWith(EVENT_ID, { userId: ADMIN_ID, role: 'admin' }, 'Agrégat déjà absent');
  });

  it('rejects unknown fields and malformed event identifiers', async () => {
    const response = await inject({
      method: 'POST', url: '/api/admin/outbox/not-a-uuid/retry', payload: { reason: 'Relance', force: true },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_outbox_request');
    expect(outbox.retry).not.toHaveBeenCalled();
  });

  it('exposes push failures through the same minimal administrative contract', async () => {
    outbox.deadLetters.mockResolvedValueOnce({
      items: [{ event_id: EVENT_ID, event_type: 'notification.push', attempts: 10, last_error_code: 'push_delivery_unavailable' }],
      next_cursor: null,
    });
    const response = await inject({ method: 'GET', url: '/api/admin/outbox/dead-letters' });
    expect(response.statusCode).toBe(200);
    expect(response.json().events[0]).toEqual({
      event_id: EVENT_ID, event_type: 'notification.push', attempts: 10, last_error_code: 'push_delivery_unavailable',
    });
    expect(response.body).not.toMatch(/payload|aggregate_id|device_id|token|notification_id/);
  });

  function inject(input: {
    method: 'GET' | 'POST';
    url: string;
    payload?: Record<string, unknown>;
  }) {
    return app.getHttpAdapter().getInstance().inject(input);
  }
});
