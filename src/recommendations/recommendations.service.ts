import { Injectable, Inject } from '@nestjs/common';
import { Client } from 'cassandra-driver';

@Injectable()
export class RecommendationsService {
  constructor(@Inject('SCYLLA') private readonly scylla: Client) {}

  async getFeed(userId: string) {
    const res = await this.scylla.execute(
      `SELECT target_user_id FROM recommendation_feed WHERE user_id=? LIMIT 20`,
      [userId],
      { prepare: true },
    );
    return res.rows.map(r => r.target_user_id);
  }
}
