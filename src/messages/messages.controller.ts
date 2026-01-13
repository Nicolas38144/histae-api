import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { MessagesService } from './messages.service';
import { User } from '../common/decorators/user.decorator';
import { JwtGuard } from '../common/guards/jwt.guard';

@Controller('messages')
export class MessagesController {
  constructor(private readonly service: MessagesService) {}

  @UseGuards(JwtGuard)
  @Get(':matchId')
  getMessages(@User() user: any, @Param('matchId') matchId: string) {
    return this.service.getMessages(user.id, matchId);
  }

  @UseGuards(JwtGuard)
  @Post(':matchId')
  sendMessage(@User() user: any, @Param('matchId') matchId: string, @Body() body: { content: string }) {
    return this.service.sendMessage(user.id, matchId, body.content);
  }
}
