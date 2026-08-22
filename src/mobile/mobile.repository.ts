import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import type { DevicePlatform, DeviceRow, NotificationType } from './mobile.models';

@Injectable()
export class MobileRepository {
  constructor(private readonly database: DatabaseService) {}

  async registerDevice(userId: string, token: string, platform: DevicePlatform, appVersion: string | null): Promise<DeviceRow> {
    return (await this.database.query<DeviceRow>(`
      INSERT INTO device_token (id, user_id, token, platform, app_version, created_at, last_used_at)
      VALUES ($1, $2, $3, $4, $5, clock_timestamp(), clock_timestamp())
      ON CONFLICT (token) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        platform = EXCLUDED.platform,
        app_version = EXCLUDED.app_version,
        last_used_at = clock_timestamp()
      RETURNING id, user_id, token, platform, app_version, created_at, last_used_at
    `, [randomUUID(), userId, token, platform, appVersion])).rows[0]!;
  }

  async devicesForUser(userId: string): Promise<DeviceRow[]> {
    return (await this.database.query<DeviceRow>(`
      SELECT id, user_id, token, platform, app_version, created_at, last_used_at
      FROM device_token WHERE user_id = $1 ORDER BY last_used_at DESC NULLS LAST, id
    `, [userId])).rows;
  }

  async removeDevice(userId: string, deviceId: string): Promise<boolean> {
    return (await this.database.query(
      'DELETE FROM device_token WHERE id = $1 AND user_id = $2',
      [deviceId, userId],
    )).rowCount === 1;
  }

  async removeToken(token: string): Promise<void> {
    await this.database.query('DELETE FROM device_token WHERE token = $1', [token]);
  }

  async tokensForUser(userId: string): Promise<string[]> {
    return (await this.database.query<{ token: string }>(`
      SELECT token FROM device_token WHERE user_id = $1 ORDER BY id
    `, [userId])).rows.map((row) => row.token);
  }

  async createNotification(userId: string, type: NotificationType, payload: Record<string, string>): Promise<void> {
    await this.database.query(`
      INSERT INTO notification (id, user_id, type, payload)
      VALUES ($1, $2, $3, $4::jsonb)
    `, [randomUUID(), userId, type, JSON.stringify(payload)]);
  }
}
