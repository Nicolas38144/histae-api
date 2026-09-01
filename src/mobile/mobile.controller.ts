import type { MessageEvent } from '@nestjs/common';
import { Controller, Delete, Get, HttpCode, HttpStatus, Post, Req, Sse, UseGuards } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { JwtActiveGuard, userId } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { ValidatedBody, ValidatedParams } from '../common/http/validated-request.decorator';
import { DeviceIdParamDto, RegisterDeviceDto } from './dto/mobile.dto';
import type { PublicDevice } from './mobile.service';
import { MobileService } from './mobile.service';
import { RealtimeService } from './realtime.service';

@Controller('api/users/me')
@UseGuards(JwtActiveGuard)

export class MobileController {
  constructor(
    private readonly mobile: MobileService,
    private readonly realtime: RealtimeService,
  ) {}

  @Get('devices')

  async devices(@Req() request: AuthenticatedRequest): Promise<{ devices: PublicDevice[] }> {
    return { devices: await this.mobile.listDevices(userId(request)) };
  }

  @Post('devices')
  @HttpCode(HttpStatus.CREATED)

  registerDevice(
    @ValidatedBody({ code: 'invalid_device_payload', message: 'The device registration request body is invalid.' }) body: RegisterDeviceDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<PublicDevice> {
    return this.mobile.registerDevice(userId(request), body.push_token, body.platform, body.app_version);
  }

  @Delete('devices/:id')
  @HttpCode(HttpStatus.NO_CONTENT)

  removeDevice(
    @ValidatedParams({ code: 'invalid_device_id', message: 'The device ID must be a valid UUID.' }) params: DeviceIdParamDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    return this.mobile.removeDevice(userId(request), params.id);
  }

  @Sse('events')

  events(@Req() request: AuthenticatedRequest): Observable<MessageEvent> {
    return this.realtime.stream(userId(request));
  }
}
