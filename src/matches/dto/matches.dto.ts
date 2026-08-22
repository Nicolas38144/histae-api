import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
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

export class ReadMessagesDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('all')
  read_through_message_id!: string;
}

export class MatchPaginationDto extends PaginationDto {}

export class AdminMatchPaginationDto extends MatchPaginationDto {
  @ApiProperty({ minLength: 3, maxLength: 500, description: 'Justification stored in the personal-data access log.' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
