import { Module } from '@nestjs/common';
import { TraitsController } from './traits.controller';
import { TraitsService } from './traits.service';

@Module({
  controllers: [TraitsController],
  providers: [TraitsService],
})
export class TraitsModule {}
