
import { IsOptional, IsString, IsUUID } from 'class-validator';

export class SendOtpDto {

  @IsString()
  phone_number!: string;
}

export class VerifyOtpDto {

  @IsString()
  phone_number!: string;

  @IsString()
  otp!: string;
}

export class RefreshTokenDto {

  @IsString()
  refresh_token!: string;
}

export class LogoutDto extends RefreshTokenDto {

  @IsOptional()
  @IsUUID()
  device_id?: string;
}
