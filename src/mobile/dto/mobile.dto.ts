import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { DevicePlatform } from '../mobile.models';
import { DEVICE_PLATFORMS } from '../mobile.models';

export class RegisterDeviceDto {
  @ApiProperty({ minLength: 20, maxLength: 4096, description: 'FCM registration token.' })
  @IsString()
  @MinLength(20)
  @MaxLength(4096)
  push_token!: string;

  @ApiProperty({ enum: DEVICE_PLATFORMS })
  @IsString()
  @IsIn([...DEVICE_PLATFORMS])
  platform!: DevicePlatform;

  @ApiPropertyOptional({ maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  app_version?: string;
}

export class DeviceIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  id!: string;
}
