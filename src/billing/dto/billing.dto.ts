import { IsIn } from 'class-validator';
import { BILLING_PERIODS } from '../billing.models';
import type { BillingPeriod } from '../billing.models';

export class CreateCheckoutDto {
  @IsIn(BILLING_PERIODS)
  billing_period!: BillingPeriod;
}
