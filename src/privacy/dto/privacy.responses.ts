import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DATA_REQUEST_STATUSES, DATA_REQUEST_TYPES } from '../privacy.models';

export class DataSubjectRequestResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) user_id!: string;
  @ApiProperty({ enum: DATA_REQUEST_TYPES }) type!: string;
  @ApiProperty({ enum: DATA_REQUEST_STATUSES }) status!: string;
  @ApiProperty({ format: 'date-time' }) requested_at!: Date;
  @ApiProperty({ format: 'date-time', nullable: true }) completed_at!: Date | null;
  @ApiProperty({ format: 'uuid', nullable: true }) handled_by!: string | null;
  @ApiPropertyOptional({ nullable: true }) notes?: string | null;
}

export class DataSubjectRequestListResponseDto {
  @ApiProperty({ type: [DataSubjectRequestResponseDto] }) requests!: DataSubjectRequestResponseDto[];
}

export class BlockedUserResponseDto {
  @ApiProperty({ format: 'uuid' }) user_id!: string;
  @ApiProperty({ nullable: true }) firstname!: string | null;
  @ApiProperty({ nullable: true }) photo!: string | null;
  @ApiProperty({ format: 'date-time' }) blocked_at!: Date;
}

export class BlockedUserListResponseDto {
  @ApiProperty({ type: [BlockedUserResponseDto] }) blocks!: BlockedUserResponseDto[];
}

export class DataAccessLogResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) accessed_user_id!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) accessor_id!: string | null;
  @ApiProperty({ nullable: true }) accessor_role!: string | null;
  @ApiProperty() action!: string;
  @ApiProperty({ nullable: true }) reason!: string | null;
  @ApiProperty({ format: 'date-time' }) accessed_at!: Date;
}

export class DataAccessLogListResponseDto {
  @ApiProperty({ type: [DataAccessLogResponseDto] }) logs!: DataAccessLogResponseDto[];
}

export class PortableDataResponseDto {
  @ApiProperty({ format: 'date-time' }) exported_at!: string;
  @ApiProperty({ type: 'object', nullable: true, additionalProperties: true }) account!: Record<string, unknown> | null;
  @ApiProperty({ type: 'object', nullable: true, additionalProperties: true }) profile!: Record<string, unknown> | null;
  @ApiProperty({ type: 'object', nullable: true, additionalProperties: true }) preferences!: Record<string, unknown> | null;
  @ApiProperty({ type: 'array', items: { type: 'object', additionalProperties: true } }) traits!: Record<string, unknown>[];
  @ApiProperty({ type: 'array', items: { type: 'object', additionalProperties: true } }) legal_choices!: Record<string, unknown>[];
  @ApiProperty({ type: 'array', items: { type: 'object', additionalProperties: true } }) matches!: Record<string, unknown>[];
  @ApiProperty({ type: 'array', items: { type: 'object', additionalProperties: true } }) authored_messages!: Record<string, unknown>[];
  @ApiProperty({ type: 'array', items: { type: 'object', additionalProperties: true } }) submitted_reports!: Record<string, unknown>[];
  @ApiProperty({ type: 'array', items: { type: 'object', additionalProperties: true } }) blocked_users!: Record<string, unknown>[];
  @ApiProperty({ type: 'object', nullable: true, additionalProperties: true }) subscription!: Record<string, unknown> | null;
}
