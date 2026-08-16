import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class PlanResponseDto {
  @ApiProperty() code!: string;
  @ApiProperty() display_name!: string;
  @ApiProperty() monthly_price_cents!: number;
  @ApiProperty() annual_price_cents!: number;
  @ApiProperty() currency!: string;
  @ApiProperty() trial_days!: number;
  @ApiPropertyOptional({ nullable: true }) weekly_continuation_limit?: number | null;
  @ApiProperty({ type: 'array', items: { type: 'object', additionalProperties: true } }) features!: Record<string, unknown>[];
}

export class PlanListResponseDto {
  @ApiProperty({ type: [PlanResponseDto] }) plans!: PlanResponseDto[];
}
