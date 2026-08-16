import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MatchesModule } from '../matches/matches.module';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryRepository } from './discovery.repository';
import { DiscoveryService } from './discovery.service';
import { DiscoveryStore } from './discovery.store';

@Module({
  imports: [AuthModule, MatchesModule],
  controllers: [DiscoveryController],
  providers: [DiscoveryRepository, DiscoveryStore, DiscoveryService],
  exports: [DiscoveryStore],
})
export class DiscoveryModule {}
