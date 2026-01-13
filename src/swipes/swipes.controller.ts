import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { SwipesService } from './swipes.service';
import { SwipeDto } from './dto/swipe.dto';
import { JwtGuard } from '../common/guards/jwt.guard';
import { User } from '../common/decorators/user.decorator';

@Controller('swipes')
export class SwipesController {
  constructor(private readonly swipesService: SwipesService) {}

  /**
   * POST /api/swipes
   */
  @UseGuards(JwtGuard)
  @Post()
  swipe(@User() user: any, @Body() dto: SwipeDto) {
    return this.swipesService.swipe(user.id, dto);
  }
}
