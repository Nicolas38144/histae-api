import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminController } from './admin.controller';
import { AdminRepository } from './admin.repository';
import { AdminMetricsRepository } from './admin-metrics.repository';
import { AdminPhotoRepository } from './admin-photo.repository';
import { AdminService } from './admin.service';
import { OutboxAdminController } from '../outbox/outbox-admin.controller';
import { OutboxAdminService } from '../outbox/outbox-admin.service';

@Module({
  imports: [AuthModule],
  controllers: [AdminController, OutboxAdminController],
  providers: [AdminRepository, AdminMetricsRepository, AdminPhotoRepository, AdminService, OutboxAdminService],
})
export class AdminModule {}
