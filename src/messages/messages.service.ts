import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class MessagesService {
  constructor(@Inject('POSTGRES') private readonly postgres: Pool) {}

  async getMessages(userId: string, matchId: string) {
    const res = await this.postgres.query(
      `SELECT * FROM message WHERE match_id=$1 ORDER BY created_at ASC`,
      [matchId],
    );
    return res.rows;
  }

  async sendMessage(userId: string, matchId: string, content: string) {
    await this.postgres.query(
      `INSERT INTO message (match_id, sender_id, receiver_id, content)
       VALUES ($1, $2, (SELECT CASE WHEN user1_id=$2 THEN user2_id ELSE user1_id END FROM match WHERE id=$1), $3)`,
      [matchId, userId, content],
    );
    return { success: true };
  }
}
