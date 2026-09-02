
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import type { AdminUserStatus, PhotoReconciliationFilter, RevenuePeriod } from '../admin.models';
import { ADMIN_USER_STATUSES, PHOTO_RECONCILIATION_FILTERS, REVENUE_PERIODS } from '../admin.models';

export class AdminRevenueQueryDto {

  @IsOptional()
  @IsIn([...REVENUE_PERIODS])
  revenue_period: RevenuePeriod = 'month_to_date';
}

export class AdminMetricsQueryDto extends AdminRevenueQueryDto {}

export class AdminUserIdParamDto {

  @IsUUID('all')
  id!: string;
}

export class AdminMatchIdParamDto {

  @IsUUID('all')
  id!: string;
}

export class AdminPhotoIdParamDto {

  @IsUUID('all')
  id!: string;
}

export class ListPhotoReconciliationDto extends PaginationDto {

  @IsOptional()
  @IsIn([...PHOTO_RECONCILIATION_FILTERS])
  status: PhotoReconciliationFilter = 'all';
}

export class ReconcilePhotoDto {

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class ListAdminUsersDto extends PaginationDto {

  @IsOptional()
  @IsIn([...ADMIN_USER_STATUSES])
  status?: AdminUserStatus;

  @IsOptional()
  @IsIn(['user', 'admin', 'superadmin'])
  role?: 'user' | 'admin' | 'superadmin';

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class AdminAccessQueryDto {

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class AdminMessageQueryDto extends PaginationDto {

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class UpdateAdminUserStatusDto {

  @IsBoolean()
  is_banned!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}
