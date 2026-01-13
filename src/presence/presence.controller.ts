import { Controller, Patch, Body } from '@nestjs/common';
import { PresenceService } from './presence.service';
import { User } from '../common/decorators/user.decorator';
import { JwtGuard } from '../common/guards/jwt.guard';
import { UseGuards } from '@nestjs/common';

@Controller('presence')
export class PresenceController {
  constructor(private readonly service: PresenceService) {}

  @UseGuards(JwtGuard)
  @Patch('heartbeat')
  heartbeat(@User() user: any, @Body() dto: { lat: number; lon: number }) {
    return this.service.updatePresence(user.id, dto);
  }
}
