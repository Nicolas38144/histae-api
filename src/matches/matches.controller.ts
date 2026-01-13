import { Controller, Get, UseGuards } from '@nestjs/common';
import { MatchesService } from './matches.service';
import { User } from '../common/decorators/user.decorator';
import { JwtGuard } from '../common/guards/jwt.guard';

@Controller('matches')
export class MatchesController {
  constructor(private readonly service: MatchesService) {}

  @UseGuards(JwtGuard)
  @Get()
  getMyMatches(@User() user: any) {
    return this.service.getMatches(user.id);
  }
}
