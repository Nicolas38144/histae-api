import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import type { AdminUserStatus } from '../admin.models';
import { ADMIN_USER_STATUSES } from '../admin.models';

export class AdminUserIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  id!: string;
}

export class AdminMatchIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  id!: string;
}

export class ListAdminUsersDto extends PaginationDto {
  @ApiPropertyOptional({ enum: ADMIN_USER_STATUSES })
  @IsOptional()
  @IsIn([...ADMIN_USER_STATUSES])
  status?: AdminUserStatus;

  @ApiPropertyOptional({ enum: ['user', 'admin', 'superadmin'] })
  @IsOptional()
  @IsIn(['user', 'admin', 'superadmin'])
  role?: 'user' | 'admin' | 'superadmin';

  @ApiPropertyOptional({ maxLength: 100, description: 'Search by first name or exact user UUID.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class AdminAccessQueryDto {
  @ApiProperty({ minLength: 3, maxLength: 500, description: 'Justification stored in the personal-data access log.' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class AdminMessageQueryDto extends PaginationDto {
  @ApiProperty({ minLength: 3, maxLength: 500, description: 'Justification stored in the personal-data access log.' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class UpdateAdminUserStatusDto {
  @ApiProperty()
  @IsBoolean()
  is_banned!: boolean;

  @ApiPropertyOptional({ maxLength: 500, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

