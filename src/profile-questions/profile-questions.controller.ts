import { Controller, Delete, Get, HttpCode, HttpStatus, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { JwtActiveGuard, userId } from '../auth/auth.guard';
import { AdminSessionGuard } from '../admin-auth/admin-auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { ValidatedBody, ValidatedParams } from '../common/http/validated-request.decorator';
import {
  CreateProfileQuestionDto,
  ProfileQuestionIdParamDto,
  ReplaceProfileAnswersDto,
  UpdateProfileQuestionDto,
} from './dto/profile-questions.dto';
import type { AdminProfileQuestion, ProfileAnswer, ProfileQuestion } from './profile-questions.models';
import { ProfileQuestionsService } from './profile-questions.service';

@Controller('api')
export class ProfileQuestionsController {
  constructor(private readonly questions: ProfileQuestionsService) {}

  @Get('profile-questions')
  @UseGuards(JwtActiveGuard)
  async list(): Promise<{ questions: ProfileQuestion[] }> {
    return { questions: await this.questions.list() };
  }

  @Get('users/me/profile-answers')
  @UseGuards(JwtActiveGuard)
  async listMine(@Req() request: AuthenticatedRequest): Promise<{ answers: ProfileAnswer[] }> {
    return { answers: await this.questions.listForUser(userId(request)) };
  }

  @Put('users/me/profile-answers')
  @UseGuards(JwtActiveGuard)
  async replaceMine(
    @ValidatedBody({ code: 'invalid_profile_answers', message: 'The profile answers request body is invalid.' }) body: ReplaceProfileAnswersDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ answers: ProfileAnswer[] }> {
    return { answers: await this.questions.replaceForUser(userId(request), body.answers) };
  }

  @Get('admin/profile-questions')
  @UseGuards(AdminSessionGuard)
  async listForAdmin(): Promise<{ questions: AdminProfileQuestion[] }> {
    return { questions: await this.questions.listForAdmin() };
  }

  @Post('admin/profile-questions')
  @UseGuards(AdminSessionGuard)
  @HttpCode(HttpStatus.CREATED)
  create(
    @ValidatedBody({ code: 'invalid_profile_question_payload', message: 'The profile question request body is invalid.' }) body: CreateProfileQuestionDto,
  ): Promise<AdminProfileQuestion> {
    return this.questions.create(body);
  }

  @Patch('admin/profile-questions/:id')
  @UseGuards(AdminSessionGuard)
  update(
    @ValidatedParams({ code: 'invalid_profile_question_id', message: 'The profile question ID must be a valid UUID.' }) params: ProfileQuestionIdParamDto,
    @ValidatedBody({ code: 'invalid_profile_question_payload', message: 'The profile question request body is invalid.' }) body: UpdateProfileQuestionDto,
  ): Promise<AdminProfileQuestion> {
    return this.questions.update(params.id, body);
  }

  @Delete('admin/profile-questions/:id')
  @UseGuards(AdminSessionGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(
    @ValidatedParams({ code: 'invalid_profile_question_id', message: 'The profile question ID must be a valid UUID.' }) params: ProfileQuestionIdParamDto,
  ): Promise<void> {
    await this.questions.delete(params.id);
  }
}
