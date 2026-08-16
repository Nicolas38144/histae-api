import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID } from 'class-validator';

export class TraitIdDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  traitId!: string;
}

export class CreateTraitDto {
  @ApiProperty({ example: 'Curieux' })
  @IsString()
  name!: string;
}

export class TraitIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  id!: string;
}
