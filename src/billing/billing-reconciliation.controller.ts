import { Controller, Get, UseGuards } from '@nestjs/common';

import { AdminSessionGuard } from '../admin-auth/admin-auth.guard';
import { ValidatedQuery } from '../common/http/validated-request.decorator';
import type { BillingReconciliationItem } from './billing.models';
import { BillingReconciliationService } from './billing-reconciliation.service';
import { ListBillingReconciliationDto } from './dto/billing-reconciliation.dto';

@Controller('api/admin/billing-reconciliation')
@UseGuards(AdminSessionGuard)
export class BillingReconciliationController {
  constructor(private readonly reconciliation: BillingReconciliationService) {}

  @Get()
  async list(
    @ValidatedQuery({
      code: 'invalid_billing_reconciliation_request',
      message: 'The billing reconciliation request is invalid.',
    }) query: ListBillingReconciliationDto,
  ): Promise<{ events: BillingReconciliationItem[]; next_cursor: string | null }> {
    const page = await this.reconciliation.list(query.kind, query.limit, query.cursor);
    return { events: page.items, next_cursor: page.next_cursor };
  }
}
