import { Injectable } from '@nestjs/common';
import { apiError } from '../common/api-error';
import type { DevicePlatform, DeviceRow } from './mobile.models';
import { MobileRepository } from './mobile.repository';

export type PublicDevice = Omit<DeviceRow, 'user_id' | 'token'>;

@Injectable()
export class MobileService {
  constructor(private readonly mobile: MobileRepository) {}

  async registerDevice(userId: string, sessionId: string, rawToken: string, platform: DevicePlatform, rawAppVersion?: string): Promise<PublicDevice> {
    const token = rawToken.trim();
    const appVersion = rawAppVersion?.trim() || null;
    const device = await this.mobile.registerDevice(userId, sessionId, token, platform, appVersion);
    if (!device) throw apiError(401, 'authentication_required', 'A valid mobile session is required.');
    return toPublicDevice(device);
  }

  async listDevices(userId: string): Promise<PublicDevice[]> {
    return (await this.mobile.devicesForUser(userId)).map(toPublicDevice);
  }

  async removeDevice(userId: string, deviceId: string): Promise<void> {
    if (!await this.mobile.removeDevice(userId, deviceId)) {
      throw apiError(404, 'device_not_found', 'The device registration could not be found.');
    }
  }
}

function toPublicDevice(device: DeviceRow): PublicDevice {
  return {
    id: device.id,
    session_id: device.session_id,
    platform: device.platform,
    app_version: device.app_version,
    created_at: device.created_at,
    last_used_at: device.last_used_at,
  };
}
