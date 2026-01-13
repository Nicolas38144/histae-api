import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class TraitsService {
  constructor(@Inject('POSTGRES') private readonly postgres: Pool) {}

  async getAllTraits() {
    const res = await this.postgres.query(`SELECT id, name FROM trait`);
    return res.rows;
  }

  async assignTrait(userId: string, traitId: string) {
    await this.postgres.query(
      `INSERT INTO user_trait (user_id, trait_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [userId, traitId],
    );
    return { success: true };
  }
}
