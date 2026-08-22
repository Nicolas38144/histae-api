import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

export class SendOtpDto {
  @ApiProperty({ example: '+33612345678' })
  @IsString()
  phone_number!: string;
}

export class VerifyOtpDto {
  @ApiProperty({ example: '+33612345678' })
  @IsString()
  phone_number!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  otp!: string;
}

export class RefreshTokenDto {
  @ApiProperty({ example: 'b9530a72-4511-46b1-b67d-0ef1c251b355:secret' })
  @IsString()
  refresh_token!: string;
}

export class LogoutDto extends RefreshTokenDto {
  @ApiProperty({
    required: false,
    format: 'uuid',
    description: 'Device registration to remove when logging out from the mobile application.',
  })
  @IsOptional()
  @IsUUID()
  device_id?: string;
}
