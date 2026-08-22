import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DEVICE_PLATFORMS } from '../mobile.models';

export class DeviceResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: DEVICE_PLATFORMS }) platform!: string;
  @ApiPropertyOptional({ nullable: true }) app_version!: string | null;
  @ApiProperty({ format: 'date-time' }) created_at!: Date;
  @ApiPropertyOptional({ format: 'date-time', nullable: true }) last_used_at!: Date | null;
}

export class DeviceListResponseDto {
  @ApiProperty({ type: [DeviceResponseDto] }) devices!: DeviceResponseDto[];
}
