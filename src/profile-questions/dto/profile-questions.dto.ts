import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type { ProfileQuestionCategory } from '../profile-questions.models';
import { PROFILE_QUESTION_CATEGORIES } from '../profile-questions.models';

export class ProfileQuestionIdParamDto {
  @IsUUID('all')
  id!: string;
}

export class ProfileAnswerInputDto {
  @IsUUID('all')
  question_id!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(300)
  answer!: string;
}

export class ReplaceProfileAnswersDto {
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => ProfileAnswerInputDto)
  answers!: ProfileAnswerInputDto[];
}

export class CreateProfileQuestionDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  prompt!: string;

  @IsIn([...PROFILE_QUESTION_CATEGORIES])
  category!: ProfileQuestionCategory;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  display_order = 100;
}

export class UpdateProfileQuestionDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  prompt?: string;

  @IsOptional()
  @IsIn([...PROFILE_QUESTION_CATEGORIES])
  category?: ProfileQuestionCategory;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  display_order?: number;
}
