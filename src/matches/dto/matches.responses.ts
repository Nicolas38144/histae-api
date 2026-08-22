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

class MatchUserResponseDto {
  @ApiProperty({ format: 'uuid' }) user_id!: string;
  @ApiProperty() firstname!: string;
  @ApiProperty({ minimum: 18 }) age!: number;
  @ApiProperty({ nullable: true }) sex!: string | null;
  @ApiProperty({ nullable: true }) bio!: string | null;
  @ApiProperty({ type: [String] }) traits!: string[];
  @ApiProperty({ nullable: true, description: 'Null until both participants reveal their photos.' }) photo!: string | null;
}

class LastMessageResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) sender_id!: string;
  @ApiProperty() content!: string;
  @ApiProperty({ format: 'date-time' }) created_at!: Date;
  @ApiProperty({ format: 'date-time', nullable: true }) read_at!: Date | null;
}

export class UserMatchResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: MATCH_STATUSES }) status!: string;
  @ApiProperty({ format: 'date-time' }) expires_at!: Date;
  @ApiPropertyOptional({ format: 'date-time' }) purge_after?: Date;
  @ApiProperty({ format: 'date-time' }) created_at!: Date;
  @ApiPropertyOptional({ format: 'date-time' }) last_message_at?: Date;
  @ApiProperty({ type: MatchUserResponseDto }) other_user!: MatchUserResponseDto;
  @ApiProperty() my_revealed!: boolean;
  @ApiProperty() photos_revealed!: boolean;
  @ApiProperty() my_continued!: boolean;
  @ApiProperty({ minimum: 0 }) unread_count!: number;
  @ApiProperty({ type: LastMessageResponseDto, nullable: true }) last_message!: LastMessageResponseDto | null;
}

export class UserMatchPageResponseDto {
  @ApiProperty({ type: [UserMatchResponseDto] }) matches!: UserMatchResponseDto[];
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

export class ReadMessagesResponseDto {
  @ApiProperty({ minimum: 0 }) updated_count!: number;
  @ApiProperty({ format: 'uuid' }) read_through_message_id!: string;
}
