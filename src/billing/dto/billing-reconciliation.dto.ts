import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import type { BillingReconciliationKind } from '../billing.models';

export class ListBillingReconciliationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @IsIn(['all', 'subscription', 'customer_creation'])
  kind: BillingReconciliationKind | 'all' = 'all';
}
