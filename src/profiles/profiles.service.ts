import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class ProfilesService {
  constructor(@Inject('POSTGRES') private readonly postgres: Pool) {}

  async getProfile(userId: string) {
    const res = await this.postgres.query(
      `SELECT firstname, bio, photo, sex, birthdate
       FROM user_profile WHERE user_id=$1`,
      [userId],
    );
    return res.rows[0];
  }
}
