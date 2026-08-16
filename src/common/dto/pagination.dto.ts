import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class PaginationDto {
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @ApiPropertyOptional({
    default: 0,
    minimum: 0,
    deprecated: true,
    description: 'Legacy offset pagination. Prefer cursor; offset must remain 0 when cursor is supplied.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset = 0;

  @ApiPropertyOptional({
    maxLength: 512,
    description: 'Opaque cursor returned as next_cursor by the previous page.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}
