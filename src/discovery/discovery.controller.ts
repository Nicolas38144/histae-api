import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtActiveGuard, userId } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { ValidatedBody, ValidatedQuery } from '../common/http/validated-request.decorator';
import { ConfigService } from '../config/config.service';
import { RateLimitService } from '../ratelimit/rate-limit.service';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { PublicMatch } from '../matches/matches.mapper';
import { CreateSwipeDto, FeedQueryDto } from './dto/discovery.dto';
import { FeedResponseDto, SwipeResponseDto } from './dto/discovery.responses';
import type { FeedCandidate, SwipeDecision } from './discovery.models';
import { DiscoveryService } from './discovery.service';

@Controller('api')
@UseGuards(JwtActiveGuard)
@ApiTags('Discovery')
@ApiBearerAuth()
export class DiscoveryController {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly limits: RateLimitService,
    private readonly config: ConfigService,
  ) {}

  @Post('swipes')
  @ApiCreatedResponse({ type: SwipeResponseDto })
  async swipe(
    @ValidatedBody({ code: 'invalid_swipe_payload', message: 'The swipe request body is invalid.' }) body: CreateSwipeDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ decision: SwipeDecision; matched: boolean; match?: PublicMatch }> {
    await this.limits.enforce('swipes', userId(request), this.config.rateLimit.swipe, 'swipe_rate_limit_exceeded');
    return this.discovery.swipe(userId(request), body.target_user_id, body.decision);
  }

  @Get('feed')
  @ApiOkResponse({ type: FeedResponseDto })
  async feed(
    @ValidatedQuery({ code: 'invalid_feed_query', message: 'The feed query is invalid.' }) query: FeedQueryDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ profiles: FeedCandidate[]; next_cursor: string | null }> {
    await this.limits.enforce('feed', userId(request), this.config.rateLimit.feed, 'feed_rate_limit_exceeded');
    return this.discovery.feed(userId(request), query.limit, query.cursor);
  }
}
