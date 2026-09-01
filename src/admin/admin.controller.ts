import { Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { AdminGuard, JwtActiveGuard, userId } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { ValidatedBody, ValidatedParams, ValidatedQuery } from '../common/http/validated-request.decorator';
import type { PublicMessage } from '../matches/matches.mapper';
import type { AdminMetrics, AdminRevenue, AdminUser, AdminUserDetail } from './admin.models';
import { AdminService } from './admin.service';
import {
  AdminAccessQueryDto,
  AdminMatchIdParamDto,
  AdminMetricsQueryDto,
  AdminMessageQueryDto,
  AdminRevenueQueryDto,
  AdminUserIdParamDto,
  ListAdminUsersDto,
  UpdateAdminUserStatusDto,
} from './dto/admin.dto';

@Controller('api/admin')
@UseGuards(JwtActiveGuard, AdminGuard)

export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('me')

  me(@Req() request: AuthenticatedRequest): { user_id: string; role: 'admin' | 'superadmin' } {
    return { user_id: userId(request), role: request.auth!.account.role as 'admin' | 'superadmin' };
  }

  @Get('metrics')

  metrics(
    @ValidatedQuery({ code: 'invalid_admin_request', message: 'The administrator request is invalid.' }) query: AdminMetricsQueryDto,
  ): Promise<AdminMetrics> {
    return this.admin.metrics(query.revenue_period);
  }

  @Get('revenue')

  revenue(
    @ValidatedQuery({ code: 'invalid_admin_request', message: 'The administrator request is invalid.' }) query: AdminRevenueQueryDto,
  ): Promise<AdminRevenue> {
    return this.admin.revenue(query.revenue_period);
  }

  @Get('users')

  async users(
    @ValidatedQuery({ code: 'invalid_admin_request', message: 'The administrator request is invalid.' }) query: ListAdminUsersDto,
  ): Promise<{ users: AdminUser[]; next_cursor: string | null }> {
    const page = await this.admin.listUsers(query.status, query.role, query.search, query.limit, query.offset, query.cursor);
    return { users: page.items, next_cursor: page.next_cursor };
  }

  @Get('users/:id')

  user(
    @ValidatedParams({ code: 'invalid_user_id', message: 'The user ID must be a valid UUID.' }) params: AdminUserIdParamDto,
    @ValidatedQuery({ code: 'invalid_admin_request', message: 'The administrator request is invalid.' }) query: AdminAccessQueryDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<AdminUserDetail> {
    return this.admin.userDetail(params.id, userId(request), adminRole(request), query.reason);
  }

  @Patch('users/:id/status')

  async updateUserStatus(
    @ValidatedParams({ code: 'invalid_user_id', message: 'The user ID must be a valid UUID.' }) params: AdminUserIdParamDto,
    @ValidatedBody({ code: 'invalid_admin_request', message: 'The administrator request is invalid.' }) body: UpdateAdminUserStatusDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ message: string }> {
    await this.admin.updateBanStatus(params.id, body.is_banned, body.reason, userId(request), adminRole(request));
    return { message: body.is_banned ? 'account banned' : 'account unbanned' };
  }

  @Get('matches/:id/messages')

  async messages(
    @ValidatedParams({ code: 'invalid_match_id', message: 'The match ID must be a valid UUID.' }) params: AdminMatchIdParamDto,
    @ValidatedQuery({ code: 'invalid_admin_request', message: 'The administrator request is invalid.' }) query: AdminMessageQueryDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ messages: PublicMessage[]; next_cursor: string | null }> {
    const page = await this.admin.messages(params.id, userId(request), adminRole(request), query.reason, query.limit, query.offset, query.cursor);
    return { messages: page.items, next_cursor: page.next_cursor };
  }
}

function adminRole(request: AuthenticatedRequest): 'admin' | 'superadmin' {
  return request.auth!.account.role as 'admin' | 'superadmin';
}
