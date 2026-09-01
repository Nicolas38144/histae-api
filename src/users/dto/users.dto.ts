import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import type { ConsentType, LookingFor, Sex } from '../users.models';
import { LEGAL_CHOICE_TYPES, LOOKING_FOR_VALUES, SEXES } from '../users.models';

export class UpdateProfileDto {

  @IsString()
  firstname!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  birthdate!: string;

  @IsOptional()
  @IsString()
  @IsIn([...SEXES])
  sex?: Sex | null;

  @IsOptional()
  @IsString()
  bio?: string | null;

}

export class UpdatePreferencesDto {

  @IsNumber({ allowNaN: false, allowInfinity: false })
  min_age!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  max_age!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  max_distance_km!: number;

  @IsString()
  @IsIn([...LOOKING_FOR_VALUES])
  looking_for!: LookingFor;
}

export class UpdatePresenceDto {

  @IsNumber({ allowNaN: false, allowInfinity: false })
  latitude!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  longitude!: number;
}

export class ConsentChoiceDto {

  @IsString()
  @IsIn([...LEGAL_CHOICE_TYPES])
  consent_type!: ConsentType;

  @IsBoolean()
  granted!: boolean;
}

export class UpdateConsentsDto {

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ConsentChoiceDto)
  consents!: ConsentChoiceDto[];
}

export class ConfirmAccountDeletionDto {

  @IsString()
  @MaxLength(128)
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[A-Za-z0-9_-]{43}$/)
  confirmation_token!: string;
}
