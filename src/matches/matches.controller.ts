import { Controller, Get, Headers, HttpCode, HttpStatus, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtActiveGuard, userId } from '../auth/auth.guard';
import { AdminSessionGuard } from '../admin-auth/admin-auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { ValidatedBody, ValidatedParams, ValidatedQuery } from '../common/http/validated-request.decorator';
import type { ContinuationQuota } from './matches.service';
import { MatchesService } from './matches.service';
import { AdminMatchPaginationDto, MatchIdParamDto, MatchMessageParamDto, MatchPaginationDto, ReadMessagesDto, SendMessageDto, UserIdParamDto } from './dto/matches.dto';
import type { PublicMatch, PublicMessage, PublicUserMatch } from './matches.mapper';
import { RateLimitService } from '../ratelimit/rate-limit.service';
import { ConfigService } from '../config/config.service';

@Controller('api')

export class MatchesController {
  constructor(
    private readonly matches: MatchesService,
    private readonly limits: RateLimitService,
    private readonly config: ConfigService,
  ) {}

  @Get('matches/me')
  @UseGuards(JwtActiveGuard)

  async myMatches(
    @ValidatedQuery({ code: 'invalid_pagination', message: 'Pagination parameters are invalid.' }) query: MatchPaginationDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ matches: PublicUserMatch[]; next_cursor: string | null }> {
    const page = await this.matches.list(userId(request), query.limit, query.offset, query.cursor);
    return { matches: page.items, next_cursor: page.next_cursor };
  }

  @Get('matches/:userId')
  @UseGuards(AdminSessionGuard)

  async userMatches(
    @ValidatedParams({ code: 'invalid_user_id', message: 'The user ID must be a valid UUID.' }) params: UserIdParamDto,
    @ValidatedQuery({ code: 'invalid_pagination', message: 'Pagination parameters are invalid.' }) query: AdminMatchPaginationDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ matches: PublicMatch[]; next_cursor: string | null }> {
    const page = await this.matches.listForAdmin(
      params.userId, userId(request), request.auth!.account.role, query.reason, query.limit, query.offset, query.cursor,
    );
    return { matches: page.items, next_cursor: page.next_cursor };
  }

  @Patch('matches/:id/reveal')
  @UseGuards(JwtActiveGuard)

  async reveal(
    @ValidatedParams({ code: 'invalid_match_id', message: 'The match ID must be a valid UUID.' }) params: MatchIdParamDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ message: string; photos_revealed: boolean }> {
    const revealed = await this.matches.reveal(params.id, userId(request));
    return { message: revealed ? 'Both participants agreed to reveal their profile photos.' : 'Photo reveal consent recorded.', photos_revealed: revealed };
  }

  @Patch('matches/:id/continue')
  @UseGuards(JwtActiveGuard)

  async continue(
    @ValidatedParams({ code: 'invalid_match_id', message: 'The match ID must be a valid UUID.' }) params: MatchIdParamDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ message: string; match_confirmed: boolean }> {
    const confirmed = await this.matches.continue(params.id, userId(request));
    return { message: confirmed ? 'Both participants agreed to continue the match.' : 'Match continuation consent recorded.', match_confirmed: confirmed };
  }

  @Get('matches/:id/messages')
  @UseGuards(JwtActiveGuard)

  async getMessages(
    @ValidatedParams({ code: 'invalid_match_id', message: 'The match ID must be a valid UUID.' }) params: MatchIdParamDto,
    @ValidatedQuery({ code: 'invalid_pagination', message: 'Pagination parameters are invalid.' }) query: MatchPaginationDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ messages: PublicMessage[]; next_cursor: string | null }> {
    const page = await this.matches.getMessages(params.id, userId(request), query.limit, query.offset, query.cursor);
    return { messages: page.items, next_cursor: page.next_cursor };
  }

  @Post('matches/:id/messages')
  @UseGuards(JwtActiveGuard)
  @HttpCode(HttpStatus.CREATED)

  async sendMessage(
    @ValidatedParams({ code: 'invalid_match_id', message: 'The match ID must be a valid UUID.' }) params: MatchIdParamDto,
    @ValidatedBody({ code: 'invalid_message_payload', message: 'The message request body is invalid.' }) body: SendMessageDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ): Promise<PublicMessage> {
    await this.limits.enforce('messages', userId(request), this.config.rateLimit.message, 'message_rate_limit_exceeded');
    return this.matches.sendMessage(params.id, userId(request), body.content, idempotencyKey);
  }

  @Patch('matches/:id/messages/read')
  @UseGuards(JwtActiveGuard)

  async markReadThrough(
    @ValidatedParams({ code: 'invalid_match_id', message: 'The match ID must be a valid UUID.' }) params: MatchIdParamDto,
    @ValidatedBody({ code: 'invalid_read_payload', message: 'The read request body is invalid.' }) body: ReadMessagesDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ updated_count: number; read_through_message_id: string }> {
    const updatedCount = await this.matches.markReadThrough(params.id, body.read_through_message_id, userId(request));
    return { updated_count: updatedCount, read_through_message_id: body.read_through_message_id };
  }

  @Patch('matches/:id/messages/:msgId/read')
  @UseGuards(JwtActiveGuard)

  async markAsRead(
    @ValidatedParams({ code: 'invalid_message_id', message: 'The message ID must be a valid UUID.' }) params: MatchMessageParamDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ message: string }> {
    await this.matches.markAsRead(params.id, params.msgId, userId(request));
    return { message: 'message marked as read' };
  }
}

@Controller('api/users/me')
@UseGuards(JwtActiveGuard)

export class ContinuationController {
  constructor(private readonly matches: MatchesService) {}

  @Get('continuation-quota')

  quota(@Req() request: AuthenticatedRequest): Promise<ContinuationQuota> {
    return this.matches.getContinuationAllowance(userId(request));
  }
}
