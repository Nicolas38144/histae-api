import { ApiProperty } from '@nestjs/swagger';

export class MessageResponseDto {
  @ApiProperty()
  message!: string;
}

export class TokenPairResponseDto {
  @ApiProperty()
  access_token!: string;

  @ApiProperty()
  refresh_token!: string;
}

export class HealthResponseDto {
  @ApiProperty({ enum: ['ok', 'ready'] })
  status!: 'ok' | 'ready';
}
