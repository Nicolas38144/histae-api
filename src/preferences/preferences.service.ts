import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class PreferencesService {
  constructor(@Inject('POSTGRES') private readonly postgres: Pool) {}

  async getPreferences(userId: string) {
    const res = await this.postgres.query(
      `SELECT * FROM user_preferences WHERE user_id=$1`,
      [userId],
    );
    return res.rows[0];
  }

  async updatePreferences(userId: string, dto: any) {
    await this.postgres.query(
      `INSERT INTO user_preferences (user_id, preferred_sex, min_age, max_age, max_distance_km)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE
       SET preferred_sex=$2, min_age=$3, max_age=$4, max_distance_km=$5`,
      [userId, dto.preferred_sex, dto.min_age, dto.max_age, dto.max_distance_km],
    );
    return { success: true };
  }
}
