import { Controller, Get, Put, Body, UseGuards } from '@nestjs/common';
import { PreferencesService } from './preferences.service';
import { User } from '../common/decorators/user.decorator';
import { JwtGuard } from '../common/guards/jwt.guard';

@Controller('preferences')
export class PreferencesController {
  constructor(private readonly service: PreferencesService) {}

  @UseGuards(JwtGuard)
  @Get('me')
  getMyPreferences(@User() user: any) {
    return this.service.getPreferences(user.id);
  }

  @UseGuards(JwtGuard)
  @Put('me')
  updatePreferences(@User() user: any, @Body() dto: any) {
    return this.service.updatePreferences(user.id, dto);
  }
}
