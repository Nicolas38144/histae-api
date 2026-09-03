import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { NotificationType } from './mobile.models';
import { BILLING_NOTIFICATION_ELIGIBLE_SQL } from './notification-billing';

export type PendingPush = {
  notification_id: string;
  token: string;
  type: NotificationType;
  payload: Record<string, string>;
};

@Injectable()
export class NotificationPushRepository {
  constructor(private readonly database: DatabaseService) {}

  async findDeliverable(id: string): Promise<PendingPush | undefined> {
    return (await this.database.query<PendingPush>(`
      SELECT n.id AS notification_id, d.token, n.type, n.payload
      FROM notification_push_delivery delivery
      JOIN notification n ON n.id = delivery.notification_id
      JOIN device_token d ON d.id = delivery.device_id AND d.user_id = n.user_id
        AND d.session_id IS NOT DISTINCT FROM delivery.session_id
      JOIN user_account account ON account.user_id = n.user_id
      LEFT JOIN refresh_token_family session ON session.id = d.session_id
      LEFT JOIN match_init m ON m.id = (n.payload->>'match_id')::uuid
      LEFT JOIN user_account first_account ON first_account.user_id = m.user1_id
      LEFT JOIN user_account second_account ON second_account.user_id = m.user2_id
      WHERE delivery.id = $1 AND account.deleted_at IS NULL AND NOT account.is_banned
        AND n.expires_at > clock_timestamp() AND n.read_at IS NULL
        AND (d.session_id IS NULL OR (session.revoked_at IS NULL AND session.expires_at > clock_timestamp()))
        AND ((${BILLING_NOTIFICATION_ELIGIBLE_SQL}) OR (
          m.status IN ('active', 'awaiting_continuation', 'confirmed')
          AND (m.status = 'confirmed' OR m.expires_at > clock_timestamp())
          AND n.user_id IN (m.user1_id, m.user2_id)
          AND first_account.deleted_at IS NULL AND NOT first_account.is_banned
          AND second_account.deleted_at IS NULL AND NOT second_account.is_banned
          AND NOT EXISTS (
            SELECT 1 FROM user_block
            WHERE (blocker_id = m.user1_id AND blocked_id = m.user2_id)
               OR (blocker_id = m.user2_id AND blocked_id = m.user1_id)
          )
          AND (n.type = 'new_match' OR (n.type = 'new_message' AND EXISTS (
            SELECT 1 FROM chat_message message
            WHERE message.id = (n.payload->>'message_id')::uuid AND message.match_id = m.id
              AND message.sender_id <> n.user_id AND message.read_at IS NULL
          )))
        ))
    `, [id])).rows[0];
  }
}
