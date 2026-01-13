import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';

@Injectable()
export class UsersService {
  constructor(
  //   @Inject('SCYLLA') private readonly scylla: ScyllaClient,
  //   @Inject('REDIS') private readonly redis: Redis
    @Inject('POSTGRES') private readonly postgres: Pool
  ) {}

  async getById(id: string) {
    const res = await this.postgres.query(
      `SELECT id, role, email, created_at FROM user_account WHERE id=$1`,
      [id],
    );
    return res.rows[0];
  }
}
