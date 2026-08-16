import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DiscoveryModule } from '../discovery/discovery.module';
import { PrivacyController } from './privacy.controller';
import { PrivacyMaintenanceService } from './privacy-maintenance.service';
import { PrivacyRepository } from './privacy.repository';
import { PrivacyService } from './privacy.service';

@Module({
  imports: [AuthModule, DiscoveryModule],
  controllers: [PrivacyController],
  providers: [PrivacyRepository, PrivacyService, PrivacyMaintenanceService],
  exports: [PrivacyRepository, PrivacyService, PrivacyMaintenanceService],
})
export class PrivacyModule {}
