import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { DataRequestStatus, DataRequestType } from '../privacy.models';
import { DATA_REQUEST_STATUSES, DATA_REQUEST_TYPES } from '../privacy.models';

export class CreateDataSubjectRequestDto {
  @ApiProperty({ enum: DATA_REQUEST_TYPES })
  @IsIn([...DATA_REQUEST_TYPES])
  type!: DataRequestType;
}

export class ListDataSubjectRequestsDto {
  @ApiPropertyOptional({ enum: DATA_REQUEST_STATUSES })
  @IsOptional()
  @IsIn([...DATA_REQUEST_STATUSES])
  status?: DataRequestStatus;
}

export class UpdateDataSubjectRequestDto {
  @ApiProperty({ enum: ['in_progress', 'completed', 'rejected'] })
  @IsIn(['in_progress', 'completed', 'rejected'])
  status!: Exclude<DataRequestStatus, 'pending'>;

  @ApiPropertyOptional({ maxLength: 2000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class UserIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  userId!: string;
}

export class PrivacyRequestIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  id!: string;
}

export class DataAccessLogQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  user_id!: string;
}
