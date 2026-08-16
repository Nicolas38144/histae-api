import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LEGAL_CHOICE_TYPES, LOOKING_FOR_VALUES, SEXES } from '../users.models';

export class ProfileResponseDto {
  @ApiProperty({ format: 'uuid' })
  user_id!: string;

  @ApiProperty()
  firstname!: string;

  @ApiProperty({ format: 'date' })
  birthdate!: string;

  @ApiPropertyOptional({ enum: SEXES })
  sex?: string;

  @ApiPropertyOptional()
  bio?: string;

  @ApiPropertyOptional()
  photo?: string;
}

export class PreferencesResponseDto {
  @ApiProperty({ format: 'uuid' })
  user_id!: string;

  @ApiProperty()
  min_age!: number;

  @ApiProperty()
  max_age!: number;

  @ApiProperty()
  max_distance_km!: number;

  @ApiProperty({ enum: LOOKING_FOR_VALUES })
  looking_for!: string;
}

export class ConsentResponseDto {
  @ApiProperty({ enum: LEGAL_CHOICE_TYPES })
  consent_type!: string;

  @ApiProperty()
  granted!: boolean;

  @ApiPropertyOptional()
  document_version?: string;

  @ApiProperty()
  required_document_version!: string;

  @ApiProperty({ format: 'uri' })
  document_url!: string;

  @ApiPropertyOptional({ format: 'date-time' })
  updated_at?: Date;
}

export class ConsentStateResponseDto {
  @ApiProperty({ type: [ConsentResponseDto] })
  consents!: ConsentResponseDto[];

  @ApiProperty()
  onboarding_complete!: boolean;

  @ApiProperty({ enum: LEGAL_CHOICE_TYPES, isArray: true })
  required_actions!: string[];
}
