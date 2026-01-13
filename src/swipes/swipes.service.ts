import { Injectable, Inject } from '@nestjs/common';
import { Client } from 'cassandra-driver';
import { Pool } from 'pg';
import { SwipeDto } from './dto/swipe.dto';

/**
 * SwipesService
 * Handles likes/dislikes/superlikes
 * - Writes to ScyllaDB
 * - Checks for mutual likes
 * - Creates matches in PostgreSQL
 */
@Injectable()
export class SwipesService {
  constructor(
    @Inject('SCYLLA') private readonly scylla: Client,
    @Inject('POSTGRES') private readonly postgres: Pool,
  ) {}

  async swipe(userId: string, dto: SwipeDto) {
    const now = new Date();

    // Insert swipe into timeline
    await this.scylla.execute(
      `INSERT INTO swipe_by_user (swiper_id, created_at, target_user_id, action)
       VALUES (?, ?, ?, ?)`,
      [userId, now, dto.targetUserId, dto.action],
      { prepare: true },
    );

    // Insert into lookup (anti-duplicate)
    await this.scylla.execute(
      `INSERT INTO swipe_lookup (swiper_id, target_user_id, action, created_at)
       VALUES (?, ?, ?, ?)`,
      [userId, dto.targetUserId, dto.action, now],
      { prepare: true },
    );

    if (dto.action !== 'like') return { matched: false };

    // Insert like received
    await this.scylla.execute(
      `INSERT INTO likes_received (target_user_id, created_at, swiper_id)
       VALUES (?, ?, ?)`,
      [dto.targetUserId, now, userId],
      { prepare: true },
    );

    // Check reverse like
    const reverse = await this.scylla.execute(
      `SELECT action FROM swipe_lookup WHERE swiper_id = ? AND target_user_id = ?`,
      [dto.targetUserId, userId],
      { prepare: true },
    );

    if (reverse.rowLength === 0) return { matched: false };

    // Create match in PostgreSQL
    const [u1, u2] = [userId, dto.targetUserId].sort();
    await this.postgres.query(
      `INSERT INTO match (user1_id, user2_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [u1, u2],
    );

    return { matched: true };
  }
}
