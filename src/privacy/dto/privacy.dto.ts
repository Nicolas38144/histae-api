
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { DataRequestStatus, DataRequestType } from '../privacy.models';
import { DATA_REQUEST_STATUSES, DATA_REQUEST_TYPES } from '../privacy.models';

export class CreateDataSubjectRequestDto {

  @IsIn([...DATA_REQUEST_TYPES])
  type!: DataRequestType;
}

export class ListDataSubjectRequestsDto {

  @IsOptional()
  @IsIn([...DATA_REQUEST_STATUSES])
  status?: DataRequestStatus;
}

export class UpdateDataSubjectRequestDto {

  @IsIn(['in_progress', 'completed', 'rejected'])
  status!: Exclude<DataRequestStatus, 'pending'>;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class UserIdParamDto {

  @IsUUID('all')
  userId!: string;
}

export class PrivacyRequestIdParamDto {

  @IsUUID('all')
  id!: string;
}

export class DataAccessLogQueryDto {

  @IsUUID('all')
  user_id!: string;
}
