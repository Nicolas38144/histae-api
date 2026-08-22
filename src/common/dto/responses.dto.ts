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

export class SessionResponseDto {
  @ApiProperty({ format: 'uuid' }) user_id!: string;
  @ApiProperty({ description: 'Whether the current terms and privacy notice have been acknowledged.' })
  onboarding_complete!: boolean;
}

export class HealthResponseDto {
  @ApiProperty({ enum: ['ok', 'ready'] })
  status!: 'ok' | 'ready';
}
