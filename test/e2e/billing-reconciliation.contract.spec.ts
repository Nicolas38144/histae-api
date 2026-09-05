import type { CanActivate } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AdminSessionGuard } from '../../src/admin-auth/admin-auth.guard';
import { BillingReconciliationController } from '../../src/billing/billing-reconciliation.controller';
import { BillingReconciliationService } from '../../src/billing/billing-reconciliation.service';
import { ApiExceptionFilter } from '../../src/common/api-exception.filter';

describe('Admin billing reconciliation HTTP contract', () => {
  let app: NestFastifyApplication;
  const reconciliation = {
    list: jest.fn().mockResolvedValue({ items: [{
      event_id: '11111111-1111-4111-8111-111111111111',
      user_id: '22222222-2222-4222-8222-222222222222',
      kind: 'subscription',
      attempts: 10,
      last_error_code: 'billing_provider_unavailable',
    }], next_cursor: null }),
  };
  const guard: CanActivate = { canActivate: () => true };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [BillingReconciliationController],
      providers: [{ provide: BillingReconciliationService, useValue: reconciliation }],
    }).overrideGuard(AdminSessionGuard).useValue(guard).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
  });

  afterAll(async () => app?.close());
  beforeEach(() => jest.clearAllMocks());

  it('lists only validated, paginated operational metadata', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/api/admin/billing-reconciliation?kind=subscription&limit=20',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ events: [expect.objectContaining({
      kind: 'subscription',
      last_error_code: 'billing_provider_unavailable',
    })], next_cursor: null });
    expect(reconciliation.list).toHaveBeenCalledWith('subscription', 20, undefined);
  });

  it('rejects unknown filters before the repository is queried', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/api/admin/billing-reconciliation?kind=invoice',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_billing_reconciliation_request');
    expect(reconciliation.list).not.toHaveBeenCalled();
  });

  it('does not silently accept offset pagination', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/api/admin/billing-reconciliation?offset=10',
    });
    expect(response.statusCode).toBe(400);
    expect(reconciliation.list).not.toHaveBeenCalled();
  });
});
