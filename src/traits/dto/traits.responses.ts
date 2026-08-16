import { ApiProperty } from '@nestjs/swagger';

export class TraitResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

export class TraitListResponseDto {
  @ApiProperty({ type: [TraitResponseDto] }) traits!: TraitResponseDto[];
}
