import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

export class DeadLetterIdParamDto {
  @IsUUID('4')
  id!: string;
}

export class DeadLetterListDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

export class ResolveDeadLetterDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
