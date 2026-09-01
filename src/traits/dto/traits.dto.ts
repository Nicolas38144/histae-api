
import { IsString, IsUUID } from 'class-validator';

export class TraitIdDto {

  @IsUUID('all')
  traitId!: string;
}

export class CreateTraitDto {

  @IsString()
  name!: string;
}

export class TraitIdParamDto {

  @IsUUID('all')
  id!: string;
}
