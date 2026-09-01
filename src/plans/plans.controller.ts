import { Controller, Get } from '@nestjs/common';
import type { SubscriptionPlan } from './plans.service';
import { PlansService } from './plans.service';

@Controller('api/plans')

export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()

  async list(): Promise<{ plans: SubscriptionPlan[] }> {
    return { plans: await this.plans.list() };
  }
}
