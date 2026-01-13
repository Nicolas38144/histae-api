import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class SubscriptionsService {
  constructor(@Inject('POSTGRES') private readonly postgres: Pool) {}

  async getPlans() {
    const res = await this.postgres.query(`SELECT * FROM subscription_plan`);
    return res.rows;
  }

  async subscribe(userId: string, planId: string) {
    const now = new Date();
    const res = await this.postgres.query(
      `SELECT duration_days FROM subscription_plan WHERE id=$1`,
      [planId],
    );
    const duration = res.rows[0].duration_days;
    const expiresAt = new Date(now.getTime() + duration * 24 * 60 * 60 * 1000);

    await this.postgres.query(
      `INSERT INTO user_subscription (user_id, plan_id, started_at, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [userId, planId, now, expiresAt],
    );
    return { success: true };
  }
}
