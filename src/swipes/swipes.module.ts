import { Module } from '@nestjs/common';
import { SwipesService } from './swipes.service';
import { SwipesController } from './swipes.controller';

@Module({
  controllers: [SwipesController],
  providers: [SwipesService],
})
export class SwipesModule {}
