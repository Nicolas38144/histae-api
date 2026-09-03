
import { Type } from 'class-transformer';
import { Equals, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

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
  @MaxLength(128)
  refresh_token!: string;
}

export class MobileSessionIdDto {
  @IsUUID('4')
  id!: string;
}

export class MobileSessionQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

export class LogoutAllDto {
  @Equals(true)
  confirm!: true;
}

export class LogoutDto extends RefreshTokenDto {

  @IsOptional()
  @IsUUID()
  device_id?: string;
}
