
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { DevicePlatform } from '../mobile.models';
import { DEVICE_PLATFORMS } from '../mobile.models';

export class RegisterDeviceDto {

  @IsString()
  @MinLength(20)
  @MaxLength(4096)
  push_token!: string;

  @IsString()
  @IsIn([...DEVICE_PLATFORMS])
  platform!: DevicePlatform;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  app_version?: string;
}

export class DeviceIdParamDto {

  @IsUUID('all')
  id!: string;
}
