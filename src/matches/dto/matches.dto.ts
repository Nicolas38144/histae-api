
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class UserIdParamDto {

  @IsUUID('all')
  userId!: string;
}

export class MatchIdParamDto {

  @IsUUID('all')
  id!: string;
}

export class MatchMessageParamDto extends MatchIdParamDto {

  @IsUUID('all')
  msgId!: string;
}

export class SendMessageDto {

  @IsString()
  content!: string;
}

export class ReadMessagesDto {

  @IsUUID('all')
  read_through_message_id!: string;
}

export class MatchPaginationDto extends PaginationDto {}

export class AdminMatchPaginationDto extends MatchPaginationDto {

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
