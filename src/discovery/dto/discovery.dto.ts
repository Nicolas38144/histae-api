import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import type { SwipeDecision } from '../discovery.models';
import { SWIPE_DECISIONS } from '../discovery.models';

export class CreateSwipeDto {

  @IsUUID('all')
  target_user_id!: string;

  @IsString()
  @IsIn([...SWIPE_DECISIONS])
  decision!: SwipeDecision;
}

export class FeedQueryDto {

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}
