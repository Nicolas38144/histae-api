import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ReportsController } from './reports.controller';
import { ReportsRepository } from './reports.repository';
import { ReportsService } from './reports.service';

@Module({ imports: [AuthModule], controllers: [ReportsController], providers: [ReportsRepository, ReportsService] })
export class ReportsModule {}
