import { Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { userId } from '../auth/auth.guard';
import { AdminSessionGuard } from '../admin-auth/admin-auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { ValidatedBody, ValidatedParams, ValidatedQuery } from '../common/http/validated-request.decorator';
import {
  ListModerationCasesDto,
  ModerationAccessQueryDto,
  ModerationCaseIdParamDto,
  ReviewModerationCaseDto,
} from './dto/moderation.dto';
import type { ModerationCase, ModerationDetail } from './moderation.models';
import { ModerationService } from './moderation.service';

@Controller('api/admin/content-moderation')
@UseGuards(AdminSessionGuard)
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @Get()
  async list(
    @ValidatedQuery({ code: 'invalid_moderation_request', message: 'The moderation request is invalid.' }) query: ListModerationCasesDto,
  ): Promise<{ cases: ModerationCase[]; next_cursor: string | null }> {
    const page = await this.moderation.list(
      query.status,
      query.content_type,
      query.limit,
      query.offset,
      query.cursor,
    );
    return { cases: page.items, next_cursor: page.next_cursor };
  }

  @Get(':id')
  detail(
    @ValidatedParams({ code: 'invalid_moderation_case_id', message: 'The moderation case ID must be a valid UUID.' }) params: ModerationCaseIdParamDto,
    @ValidatedQuery({ code: 'invalid_moderation_request', message: 'The moderation request is invalid.' }) query: ModerationAccessQueryDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ModerationDetail> {
    return this.moderation.detail(params.id, userId(request), adminRole(request), query.reason);
  }

  @Patch(':id')
  async review(
    @ValidatedParams({ code: 'invalid_moderation_case_id', message: 'The moderation case ID must be a valid UUID.' }) params: ModerationCaseIdParamDto,
    @ValidatedBody({ code: 'invalid_moderation_request', message: 'The moderation request is invalid.' }) body: ReviewModerationCaseDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ message: string }> {
    await this.moderation.review(
      params.id,
      body.version,
      body.decision,
      body.reason,
      body.photo_checks,
      userId(request),
      adminRole(request),
    );
    return { message: 'content moderation decision recorded' };
  }
}

function adminRole(request: AuthenticatedRequest): 'admin' | 'superadmin' {
  return request.auth!.account.role as 'admin' | 'superadmin';
}
