import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { SubscriptionPlan } from './plans.service';
import { PlansService } from './plans.service';
import { PlanListResponseDto } from './dto/plans.responses';

@Controller('api/plans')
@ApiTags('Plans')
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  @ApiOkResponse({ type: PlanListResponseDto })
  async list(): Promise<{ plans: SubscriptionPlan[] }> {
    return { plans: await this.plans.list() };
  }
}
