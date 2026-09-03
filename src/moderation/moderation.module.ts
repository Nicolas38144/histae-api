import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ModerationController } from './moderation.controller';
import { ModerationRepository } from './moderation.repository';
import { ModerationService } from './moderation.service';

@Module({
  imports: [AuthModule],
  controllers: [ModerationController],
  providers: [ModerationRepository, ModerationService],
})
export class ModerationModule {}
