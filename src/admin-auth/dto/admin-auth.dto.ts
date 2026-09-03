import { Type } from 'class-transformer';
import { IsInt, IsObject, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';

const BOOTSTRAP_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[A-Za-z0-9_-]{43}$/i;

export class BootstrapRegistrationOptionsDto {
  @IsString()
  @Matches(BOOTSTRAP_TOKEN_PATTERN)
  bootstrap_token!: string;
}

export class BootstrapRegistrationVerifyDto extends BootstrapRegistrationOptionsDto {
  @IsUUID('4')
  challenge_id!: string;

  @IsObject()
  credential!: Record<string, unknown>;

  @IsString()
  @Length(1, 100)
  @MaxLength(100)
  name!: string;
}

export class AuthenticationVerifyDto {
  @IsUUID('4')
  challenge_id!: string;

  @IsObject()
  credential!: Record<string, unknown>;
}

export class AdditionalCredentialVerifyDto extends AuthenticationVerifyDto {
  @IsString()
  @Length(1, 100)
  @MaxLength(100)
  name!: string;
}

export class AdminCredentialIdParamDto {
  @IsUUID('4')
  id!: string;
}

export class AdminSessionIdParamDto extends AdminCredentialIdParamDto {}

export class RenameAdminCredentialDto {
  @IsString()
  @Length(1, 100)
  @MaxLength(100)
  name!: string;
}

export class AdminAuthEventsQueryDto {
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
