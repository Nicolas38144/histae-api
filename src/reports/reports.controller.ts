import { Controller, Get, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtActiveGuard, userId } from '../auth/auth.guard';
import { AdminSessionGuard } from '../admin-auth/admin-auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { ValidatedBody, ValidatedParams, ValidatedQuery } from '../common/http/validated-request.decorator';
import { ConfigService } from '../config/config.service';
import { RateLimitService } from '../ratelimit/rate-limit.service';
import { ReportsService } from './reports.service';
import { CreateReportDto, ListReportsDto, ReportIdParamDto, UpdateReportDto } from './dto/reports.dto';
import type { PublicReport } from './reports.mapper';

@Controller('api')

export class ReportsController {
  constructor(private readonly reports: ReportsService, private readonly limits: RateLimitService, private readonly config: ConfigService) {}

  @Post('reports')
  @UseGuards(JwtActiveGuard)

  async create(
    @ValidatedBody({ code: 'invalid_report_payload', message: 'The report request body is invalid.' }) body: CreateReportDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<PublicReport> {
    await this.limits.enforce('reports', userId(request), this.config.rateLimit.report, 'report_rate_limit_exceeded');
    return this.reports.create(userId(request), { ...body, match_id: body.match_id ?? null, description: body.description ?? null });
  }

  @Get('admin/reports')
  @UseGuards(AdminSessionGuard)

  async list(
    @ValidatedQuery({ code: 'invalid_report_request', message: 'The report request is invalid.' }) query: ListReportsDto,
  ): Promise<{ reports: PublicReport[]; next_cursor: string | null }> {
    const page = await this.reports.list(query.status ?? '', query.limit, query.offset, query.cursor);
    return { reports: page.items, next_cursor: page.next_cursor };
  }

  @Patch('admin/reports/:id')
  @UseGuards(AdminSessionGuard)

  async update(
    @ValidatedParams({ code: 'invalid_report_id', message: 'The report ID must be a valid UUID.' }) params: ReportIdParamDto,
    @ValidatedBody({ code: 'invalid_report_payload', message: 'The report request body is invalid.' }) body: UpdateReportDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ message: string }> {
    await this.reports.updateStatus(params.id, body.status, userId(request), request.auth!.account.role);
    return { message: 'report updated' };
  }
}
