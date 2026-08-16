import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MatchResponseDto } from '../../matches/dto/matches.responses';
import { SEXES } from '../../users/users.models';
import { SWIPE_DECISIONS } from '../discovery.models';

class FeedCandidateResponseDto {
  @ApiProperty({ format: 'uuid' }) user_id!: string;
  @ApiProperty() firstname!: string;
  @ApiProperty({ minimum: 18 }) age!: number;
  @ApiProperty({ enum: SEXES }) sex!: string;
  @ApiPropertyOptional({ nullable: true }) bio!: string | null;
  @ApiProperty({ minimum: 0 }) distance_km!: number;
  @ApiProperty({ type: [String] }) traits!: string[];
}

export class FeedResponseDto {
  @ApiProperty({ type: [FeedCandidateResponseDto] }) profiles!: FeedCandidateResponseDto[];
  @ApiProperty({ nullable: true }) next_cursor!: string | null;
}

export class SwipeResponseDto {
  @ApiProperty({ enum: SWIPE_DECISIONS }) decision!: string;
  @ApiProperty() matched!: boolean;
  @ApiPropertyOptional({ type: MatchResponseDto }) match?: MatchResponseDto;
}
