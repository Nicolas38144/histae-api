import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ContinuationController, MatchesController } from './matches.controller';
import { MatchMaintenanceService } from './match-maintenance.service';
import { MatchesRepository } from './matches.repository';
import { MatchesService } from './matches.service';

@Module({
  imports: [AuthModule],
  controllers: [MatchesController, ContinuationController],
  providers: [MatchesRepository, MatchesService, MatchMaintenanceService],
  exports: [MatchesService, MatchMaintenanceService],
})
export class MatchesModule {}
