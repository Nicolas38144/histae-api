import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import type { SwipeDecision } from '../discovery.models';
import { SWIPE_DECISIONS } from '../discovery.models';

export class CreateSwipeDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  target_user_id!: string;

  @ApiProperty({ enum: SWIPE_DECISIONS })
  @IsString()
  @IsIn([...SWIPE_DECISIONS])
  decision!: SwipeDecision;
}

export class FeedQueryDto {
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @ApiPropertyOptional({ maxLength: 512, description: 'Opaque cursor returned by the previous feed page.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}
