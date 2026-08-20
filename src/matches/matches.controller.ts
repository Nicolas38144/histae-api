import { Controller, Get, HttpCode, HttpStatus, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AdminGuard, JwtActiveGuard, userId } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { ValidatedBody, ValidatedParams, ValidatedQuery } from '../common/http/validated-request.decorator';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { ContinuationQuota } from './matches.service';
import { MatchesService } from './matches.service';
import { AdminMatchPaginationDto, MatchIdParamDto, MatchMessageParamDto, MatchPaginationDto, SendMessageDto, UserIdParamDto } from './dto/matches.dto';
import type { PublicMatch, PublicMessage } from './matches.mapper';
import { ChatMessageResponseDto, ContinuationQuotaResponseDto, ContinuationResponseDto, MatchPageResponseDto, MessagePageResponseDto, RevealResponseDto } from './dto/matches.responses';
import { MessageResponseDto } from '../common/dto/responses.dto';
import { RateLimitService } from '../ratelimit/rate-limit.service';
import { ConfigService } from '../config/config.service';

@Controller('api')
@ApiTags('Matches')
@ApiBearerAuth()
export class MatchesController {
  constructor(
    private readonly matches: MatchesService,
    private readonly limits: RateLimitService,
    private readonly config: ConfigService,
  ) {}

  @Get('matches/me')
  @UseGuards(JwtActiveGuard)
  @ApiOkResponse({ type: MatchPageResponseDto })
  async myMatches(
    @ValidatedQuery({ code: 'invalid_pagination', message: 'Pagination parameters are invalid.' }) query: MatchPaginationDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ matches: PublicMatch[]; next_cursor: string | null }> {
    const page = await this.matches.list(userId(request), query.limit, query.offset, query.cursor);
    return { matches: page.items, next_cursor: page.next_cursor };
  }

  @Get('matches/:userId')
  @UseGuards(JwtActiveGuard, AdminGuard)
  @ApiOkResponse({ type: MatchPageResponseDto })
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
  @ApiOkResponse({ type: RevealResponseDto })
  async reveal(
    @ValidatedParams({ code: 'invalid_match_id', message: 'The match ID must be a valid UUID.' }) params: MatchIdParamDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ message: string; photos_revealed: boolean }> {
    const revealed = await this.matches.reveal(params.id, userId(request));
    return { message: revealed ? 'Both participants agreed to reveal their profile photos.' : 'Photo reveal consent recorded.', photos_revealed: revealed };
  }

  @Patch('matches/:id/continue')
  @UseGuards(JwtActiveGuard)
  @ApiOkResponse({ type: ContinuationResponseDto })
  async continue(
    @ValidatedParams({ code: 'invalid_match_id', message: 'The match ID must be a valid UUID.' }) params: MatchIdParamDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ message: string; match_confirmed: boolean }> {
    const confirmed = await this.matches.continue(params.id, userId(request));
    return { message: confirmed ? 'Both participants agreed to continue the match.' : 'Match continuation consent recorded.', match_confirmed: confirmed };
  }

  @Get('matches/:id/messages')
  @UseGuards(JwtActiveGuard)
  @ApiOkResponse({ type: MessagePageResponseDto })
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
  @ApiCreatedResponse({ type: ChatMessageResponseDto })
  async sendMessage(
    @ValidatedParams({ code: 'invalid_match_id', message: 'The match ID must be a valid UUID.' }) params: MatchIdParamDto,
    @ValidatedBody({ code: 'invalid_message_payload', message: 'The message request body is invalid.' }) body: SendMessageDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<PublicMessage> {
    await this.limits.enforce('messages', userId(request), this.config.rateLimit.message, 'message_rate_limit_exceeded');
    return this.matches.sendMessage(params.id, userId(request), body.content);
  }

  @Patch('matches/:id/messages/:msgId/read')
  @UseGuards(JwtActiveGuard)
  @ApiOkResponse({ type: MessageResponseDto })
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
@ApiTags('Users')
@ApiBearerAuth()
export class ContinuationController {
  constructor(private readonly matches: MatchesService) {}

  @Get('continuation-quota')
  @ApiOkResponse({ type: ContinuationQuotaResponseDto })
  quota(@Req() request: AuthenticatedRequest): Promise<ContinuationQuota> {
    return this.matches.getContinuationAllowance(userId(request));
  }
}
