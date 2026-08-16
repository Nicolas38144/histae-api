import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import type { ReportReason, ReportStatus } from '../reports.models';
import { REPORT_REASONS, REPORT_STATUSES } from '../reports.models';

export class CreateReportDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  reported_user_id!: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('all')
  match_id?: string | null;

  @ApiProperty({ enum: REPORT_REASONS })
  @IsString()
  @IsIn([...REPORT_REASONS])
  reason!: ReportReason;

  @ApiPropertyOptional({ maxLength: 2000, nullable: true })
  @IsOptional()
  @IsString()
  description?: string | null;
}

export class ReportIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  id!: string;
}

export class UpdateReportDto {
  @ApiProperty({ enum: REPORT_STATUSES })
  @IsString()
  @IsIn([...REPORT_STATUSES])
  status!: ReportStatus;
}

export class ListReportsDto extends PaginationDto {
  @ApiPropertyOptional({ enum: REPORT_STATUSES })
  @IsOptional()
  @IsString()
  @IsIn([...REPORT_STATUSES])
  status?: ReportStatus;
}
