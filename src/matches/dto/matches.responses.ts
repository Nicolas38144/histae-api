import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MATCH_STATUSES } from '../matches.models';

export class MatchResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) user1_id!: string;
  @ApiProperty({ format: 'uuid' }) user2_id!: string;
  @ApiProperty({ enum: MATCH_STATUSES }) status!: string;
  @ApiProperty({ format: 'date-time' }) expires_at!: Date;
  @ApiPropertyOptional({ format: 'date-time' }) purge_after?: Date;
  @ApiProperty({ format: 'date-time' }) created_at!: Date;
  @ApiPropertyOptional({ format: 'date-time' }) last_message_at?: Date;
}

export class MatchPageResponseDto {
  @ApiProperty({ type: [MatchResponseDto] }) matches!: MatchResponseDto[];
  @ApiProperty({ nullable: true }) next_cursor!: string | null;
}

export class ChatMessageResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) match_id!: string;
  @ApiProperty({ format: 'uuid' }) sender_id!: string;
  @ApiProperty() content!: string;
  @ApiProperty({ format: 'date-time' }) created_at!: Date;
  @ApiPropertyOptional({ format: 'date-time' }) read_at?: Date;
}

export class MessagePageResponseDto {
  @ApiProperty({ type: [ChatMessageResponseDto] }) messages!: ChatMessageResponseDto[];
  @ApiProperty({ nullable: true }) next_cursor!: string | null;
}

export class RevealResponseDto {
  @ApiProperty() message!: string;
  @ApiProperty() photos_revealed!: boolean;
}

export class ContinuationResponseDto {
  @ApiProperty() message!: string;
  @ApiProperty() match_confirmed!: boolean;
}

export class ContinuationQuotaResponseDto {
  @ApiProperty() plan!: string;
  @ApiProperty() used!: number;
  @ApiPropertyOptional() weekly_limit?: number;
  @ApiPropertyOptional() remaining?: number;
}
