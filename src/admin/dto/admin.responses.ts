import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AdminSessionResponseDto {
  @ApiProperty({ format: 'uuid' }) user_id!: string;
  @ApiProperty({ enum: ['admin', 'superadmin'] }) role!: string;
}

export class AdminUserResponseDto {
  @ApiProperty({ format: 'uuid' }) user_id!: string;
  @ApiProperty({ enum: ['user', 'admin', 'superadmin'] }) role!: string;
  @ApiProperty() is_banned!: boolean;
  @ApiPropertyOptional({ format: 'date-time', nullable: true }) banned_at!: Date | null;
  @ApiProperty({ format: 'date-time' }) created_at!: Date;
  @ApiPropertyOptional({ nullable: true }) firstname!: string | null;
  @ApiPropertyOptional({ format: 'date', nullable: true }) birthdate!: string | null;
  @ApiPropertyOptional({ nullable: true }) sex!: string | null;
  @ApiPropertyOptional({ nullable: true }) photo!: string | null;
  @ApiProperty() plan!: string;
  @ApiProperty() onboarding_complete!: boolean;
  @ApiProperty() reports_received!: number;
  @ApiProperty() matches_count!: number;
}

export class AdminUserPageResponseDto {
  @ApiProperty({ type: [AdminUserResponseDto] }) users!: AdminUserResponseDto[];
  @ApiProperty({ nullable: true }) next_cursor!: string | null;
}

export class AdminUserDetailResponseDto extends AdminUserResponseDto {
  @ApiPropertyOptional({ nullable: true }) banned_reason!: string | null;
  @ApiPropertyOptional({ type: 'object', nullable: true, additionalProperties: true }) preferences!: Record<string, unknown> | null;
  @ApiProperty({ type: 'array', items: { type: 'object', additionalProperties: true } }) traits!: Record<string, unknown>[];
  @ApiProperty({ type: 'array', items: { type: 'object', additionalProperties: true } }) consents!: Record<string, unknown>[];
  @ApiPropertyOptional({ type: 'object', nullable: true, additionalProperties: true }) presence!: Record<string, unknown> | null;
}

export class AdminMetricsResponseDto {
  @ApiProperty({ type: 'object', additionalProperties: true }) users!: Record<string, number>;
  @ApiProperty({ type: 'object', additionalProperties: true }) moderation!: Record<string, number>;
  @ApiProperty({ type: 'object', additionalProperties: true }) matches!: Record<string, number>;
  @ApiProperty({ type: 'object', additionalProperties: true }) messages!: Record<string, number>;
  @ApiProperty({ type: 'array', items: { type: 'object', additionalProperties: true } }) subscriptions!: Record<string, unknown>[];
}

export class AdminMessagePageResponseDto {
  @ApiProperty({ type: 'array', items: { type: 'object', additionalProperties: true } }) messages!: Record<string, unknown>[];
  @ApiProperty({ nullable: true }) next_cursor!: string | null;
}

