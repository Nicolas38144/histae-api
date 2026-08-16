import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import type { ConsentType, LookingFor, Sex } from '../users.models';
import { LEGAL_CHOICE_TYPES, LOOKING_FOR_VALUES, SEXES } from '../users.models';

export class UpdateProfileDto {
  @ApiProperty({ example: 'Nicolas' })
  @IsString()
  firstname!: string;

  @ApiProperty({ example: '1990-01-01', description: 'Calendar date in YYYY-MM-DD format.' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  birthdate!: string;

  @ApiPropertyOptional({ enum: SEXES, nullable: true })
  @IsOptional()
  @IsString()
  @IsIn([...SEXES])
  sex?: Sex | null;

  @ApiPropertyOptional({ example: 'Passionné par la culture et les voyages.', nullable: true })
  @IsOptional()
  @IsString()
  bio?: string | null;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/profile.jpg', nullable: true })
  @IsOptional()
  @IsString()
  photo?: string | null;
}

export class UpdatePreferencesDto {
  @ApiProperty({ example: 25 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  min_age!: number;

  @ApiProperty({ example: 40 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  max_age!: number;

  @ApiProperty({ example: 30 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  max_distance_km!: number;

  @ApiProperty({ enum: LOOKING_FOR_VALUES })
  @IsString()
  @IsIn([...LOOKING_FOR_VALUES])
  looking_for!: LookingFor;
}

export class UpdatePresenceDto {
  @ApiProperty({ example: 48.8566 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  latitude!: number;

  @ApiProperty({ example: 2.3522 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  longitude!: number;
}

export class ConsentChoiceDto {
  @ApiProperty({ enum: LEGAL_CHOICE_TYPES })
  @IsString()
  @IsIn([...LEGAL_CHOICE_TYPES])
  consent_type!: ConsentType;

  @ApiProperty({ example: true })
  @IsBoolean()
  granted!: boolean;
}

export class UpdateConsentsDto {
  @ApiProperty({ type: [ConsentChoiceDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ConsentChoiceDto)
  consents!: ConsentChoiceDto[];
}
