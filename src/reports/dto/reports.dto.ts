
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import type { ReportReason, ReportStatus } from '../reports.models';
import { REPORT_REASONS, REPORT_STATUSES } from '../reports.models';

export class CreateReportDto {

  @IsUUID('all')
  reported_user_id!: string;

  @IsOptional()
  @IsUUID('all')
  match_id?: string | null;

  @IsString()
  @IsIn([...REPORT_REASONS])
  reason!: ReportReason;

  @IsOptional()
  @IsString()
  description?: string | null;
}

export class ReportIdParamDto {

  @IsUUID('all')
  id!: string;
}

export class UpdateReportDto {

  @IsString()
  @IsIn([...REPORT_STATUSES])
  status!: ReportStatus;
}

export class ListReportsDto extends PaginationDto {

  @IsOptional()
  @IsString()
  @IsIn([...REPORT_STATUSES])
  status?: ReportStatus;
}
