import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import {
  MODERATION_CONTENT_TYPES,
  MODERATION_DECISIONS,
  MODERATION_STATUSES,
  type ModerationContentType,
  type ModerationDecision,
  type ModerationStatus,
} from '../moderation.models';

export class ModerationCaseIdParamDto {
  @IsUUID('all')
  id!: string;
}

export class ListModerationCasesDto extends PaginationDto {
  @IsOptional()
  @IsIn([...MODERATION_STATUSES])
  status?: ModerationStatus;

  @IsOptional()
  @IsIn([...MODERATION_CONTENT_TYPES])
  content_type?: ModerationContentType;
}

export class ModerationAccessQueryDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class PhotoReviewChecksDto {
  @IsBoolean()
  face_detectable!: boolean;

  @IsBoolean()
  sharp_enough!: boolean;

  @IsBoolean()
  content_allowed!: boolean;
}

export class ReviewModerationCaseDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version!: number;

  @IsIn([...MODERATION_DECISIONS])
  decision!: ModerationDecision;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PhotoReviewChecksDto)
  photo_checks?: PhotoReviewChecksDto;
}
