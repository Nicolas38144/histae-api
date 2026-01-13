import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { TraitsService } from './traits.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { User } from '../common/decorators/user.decorator';

@Controller('traits')
export class TraitsController {
  constructor(private readonly service: TraitsService) {}

  @Get()
  getAllTraits() {
    return this.service.getAllTraits();
  }

  @UseGuards(JwtGuard)
  @Post('assign')
  assignTrait(@User() user: any, @Body() body: { traitId: string }) {
    return this.service.assignTrait(user.id, body.traitId);
  }
}
