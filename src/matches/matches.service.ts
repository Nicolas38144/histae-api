import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class MatchesService {
  constructor(@Inject('POSTGRES') private readonly postgres: Pool) {}

  async getMatches(userId: string) {
    const res = await this.postgres.query(
      `SELECT * FROM match
       WHERE user1_id=$1 OR user2_id=$1`,
      [userId],
    );
    return res.rows;
  }
}
