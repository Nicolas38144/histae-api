import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProfileQuestionsController } from './profile-questions.controller';
import { ProfileQuestionsRepository } from './profile-questions.repository';
import { ProfileQuestionsService } from './profile-questions.service';

@Module({
  imports: [AuthModule],
  controllers: [ProfileQuestionsController],
  providers: [ProfileQuestionsRepository, ProfileQuestionsService],
})
export class ProfileQuestionsModule {}
