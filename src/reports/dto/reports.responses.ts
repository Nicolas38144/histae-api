import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { REPORT_REASONS, REPORT_STATUSES } from '../reports.models';

export class ReportResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) reporter_id!: string;
  @ApiProperty({ format: 'uuid' }) reported_id!: string;
  @ApiPropertyOptional({ format: 'uuid' }) match_id?: string;
  @ApiProperty({ enum: REPORT_REASONS }) reason!: string;
  @ApiPropertyOptional() description?: string;
  @ApiProperty({ enum: REPORT_STATUSES }) status!: string;
  @ApiProperty({ format: 'date-time' }) created_at!: Date;
}

export class ReportPageResponseDto {
  @ApiProperty({ type: [ReportResponseDto] }) reports!: ReportResponseDto[];
  @ApiProperty({ nullable: true }) next_cursor!: string | null;
}
