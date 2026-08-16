import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class UserIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  userId!: string;
}

export class MatchIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  id!: string;
}

export class MatchMessageParamDto extends MatchIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  msgId!: string;
}

export class SendMessageDto {
  @ApiProperty({ example: 'Bonjour ! Comment vas-tu ?' })
  @IsString()
  content!: string;
}

export class MatchPaginationDto extends PaginationDto {}
