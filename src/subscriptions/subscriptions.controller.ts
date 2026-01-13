import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { User } from '../common/decorators/user.decorator';

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly service: SubscriptionsService) {}

  @UseGuards(JwtGuard)
  @Get('plans')
  getPlans() {
    return this.service.getPlans();
  }

  @UseGuards(JwtGuard)
  @Post('subscribe')
  subscribe(@User() user: any, @Body() body: { planId: string }) {
    return this.service.subscribe(user.id, body.planId);
  }
}
