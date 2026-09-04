import { Controller, Delete, Get, HttpCode, HttpStatus, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtActiveGuard, userId } from '../auth/auth.guard';
import { AdminSessionGuard, RecentAdminAuthenticationGuard } from '../admin-auth/admin-auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { AllowIncompleteOnboarding } from '../auth/onboarding.decorator';
import { ValidatedBody, ValidatedParams, ValidatedQuery } from '../common/http/validated-request.decorator';
import { CreateDataSubjectRequestDto, DataAccessLogQueryDto, ListDataSubjectRequestsDto, PrivacyRequestIdParamDto, UpdateDataSubjectRequestDto, UserIdParamDto } from './dto/privacy.dto';
import type { BlockedUser, DataAccessLogRow, DataSubjectRequestRow, PortableUserData } from './privacy.models';
import { PrivacyService } from './privacy.service';
import { RateLimitService } from '../ratelimit/rate-limit.service';
import { ConfigService } from '../config/config.service';

@Controller('api')
@UseGuards(JwtActiveGuard)

export class PrivacyController {
  constructor(
    private readonly privacy: PrivacyService,
    private readonly limits: RateLimitService,
    private readonly config: ConfigService,
  ) {}

  @Post('users/me/data-subject-requests')
  @AllowIncompleteOnboarding()

  async createRequest(
    @ValidatedBody({ code: 'invalid_data_request', message: 'The data subject request is invalid.' }) body: CreateDataSubjectRequestDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<DataSubjectRequestRow> {
    return this.privacy.createRequest(userId(request), body.type);
  }

  @Get('users/me/data-subject-requests')
  @AllowIncompleteOnboarding()

  async myRequests(@Req() request: AuthenticatedRequest): Promise<{ requests: DataSubjectRequestRow[] }> {
    return { requests: await this.privacy.requestsForUser(userId(request)) };
  }

  @Get('users/me/data-export')
  @AllowIncompleteOnboarding()

  async export(@Req() request: AuthenticatedRequest): Promise<PortableUserData> {
    await this.limits.enforce('data-export', userId(request), this.config.rateLimit.dataExport, 'data_export_rate_limit_exceeded');
    return this.privacy.exportUserData(userId(request));
  }

  @Get('users/me/blocks')

  async blocks(@Req() request: AuthenticatedRequest): Promise<{ blocks: BlockedUser[] }> {
    return { blocks: await this.privacy.blockedUsers(userId(request)) };
  }

  @Post('users/me/blocks/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)

  async block(
    @ValidatedParams({ code: 'invalid_user_id', message: 'The user ID must be a valid UUID.' }) params: UserIdParamDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.privacy.blockUser(userId(request), params.userId);
  }

  @Delete('users/me/blocks/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)

  async unblock(
    @ValidatedParams({ code: 'invalid_user_id', message: 'The user ID must be a valid UUID.' }) params: UserIdParamDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.privacy.unblockUser(userId(request), params.userId);
  }

}

@Controller('api/admin')
@UseGuards(AdminSessionGuard)
export class AdminPrivacyController {
  constructor(private readonly privacy: PrivacyService) {}

  @Get('data-subject-requests')
  async requests(
    @ValidatedQuery({ code: 'invalid_data_request_query', message: 'The data subject request query is invalid.' }) query: ListDataSubjectRequestsDto,
  ): Promise<{ requests: DataSubjectRequestRow[] }> {
    return { requests: await this.privacy.requestsForAdmin(query.status) };
  }

  @Patch('data-subject-requests/:id')
  @UseGuards(RecentAdminAuthenticationGuard)
  async updateRequest(
    @ValidatedParams({ code: 'invalid_data_request_id', message: 'The data subject request ID is invalid.' }) params: PrivacyRequestIdParamDto,
    @ValidatedBody({ code: 'invalid_data_request', message: 'The data subject request is invalid.' }) body: UpdateDataSubjectRequestDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ message: string }> {
    const result = await this.privacy.updateRequest(params.id, body.status, userId(request), request.auth!.account.role, body.notes ?? null);
    return { message: result === 'erasure_scheduled' ? 'account erasure scheduled' : 'data subject request updated' };
  }

  @Get('data-access-logs')
  async logs(
    @ValidatedQuery({ code: 'invalid_data_access_query', message: 'The data access query is invalid.' }) query: DataAccessLogQueryDto,
  ): Promise<{ logs: DataAccessLogRow[] }> {
    return { logs: await this.privacy.accessLogs(query.user_id) };
  }
}
