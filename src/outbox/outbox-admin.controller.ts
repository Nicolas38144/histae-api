import { Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { AdminSessionGuard, RecentAdminAuthenticationGuard } from '../admin-auth/admin-auth.guard';
import { userId } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { ValidatedBody, ValidatedParams, ValidatedQuery } from '../common/http/validated-request.decorator';
import type { DeadLetter, OutboxOperator } from './outbox.models';
import { DeadLetterIdParamDto, DeadLetterListDto, ResolveDeadLetterDto } from './dto/outbox-admin.dto';
import { OutboxAdminService } from './outbox-admin.service';

const OUTBOX_ERROR = { code: 'invalid_outbox_request', message: 'The outbox administrator request is invalid.' };

@Controller('api/admin/outbox')
@UseGuards(AdminSessionGuard)
export class OutboxAdminController {
  constructor(private readonly outbox: OutboxAdminService) {}

  @Get('dead-letters')
  async deadLetters(
    @ValidatedQuery(OUTBOX_ERROR) query: DeadLetterListDto,
  ): Promise<{ events: DeadLetter[]; next_cursor: string | null }> {
    const page = await this.outbox.deadLetters(query.limit, query.cursor);
    return { events: page.items, next_cursor: page.next_cursor };
  }

  @Post(':id/retry')
  @UseGuards(RecentAdminAuthenticationGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  async retry(
    @ValidatedParams(OUTBOX_ERROR) params: DeadLetterIdParamDto,
    @ValidatedBody(OUTBOX_ERROR) body: ResolveDeadLetterDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ message: string }> {
    await this.outbox.retry(params.id, operator(request), body.reason);
    return { message: 'outbox event queued' };
  }

  @Post(':id/discard')
  @UseGuards(RecentAdminAuthenticationGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async discard(
    @ValidatedParams(OUTBOX_ERROR) params: DeadLetterIdParamDto,
    @ValidatedBody(OUTBOX_ERROR) body: ResolveDeadLetterDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.outbox.discard(params.id, operator(request), body.reason);
  }
}

function operator(request: AuthenticatedRequest): OutboxOperator {
  return {
    userId: userId(request),
    role: request.auth!.account.role as 'admin' | 'superadmin',
  };
}
