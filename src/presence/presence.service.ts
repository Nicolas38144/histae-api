import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class PresenceService {
  constructor(@Inject('POSTGRES') private readonly postgres: Pool) {}

  async updatePresence(userId: string, coords: { lat: number; lon: number }) {
    await this.postgres.query(
      `INSERT INTO user_presence (user_id, last_active_at, location, updated_at)
       VALUES ($1, NOW(), ST_SetSRID(ST_MakePoint($2, $3), 4326), NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET last_active_at=NOW(), location=ST_SetSRID(ST_MakePoint($2, $3), 4326), updated_at=NOW()`,
      [userId, coords.lon, coords.lat],
    );
    return { success: true };
  }
}
