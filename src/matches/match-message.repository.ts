import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import type { KeysetCursor } from '../common/pagination';
import type { CursorMessageRow, MatchCommandResult, MatchRow, MessageCreationResult, MessageRead, MessageRow } from './matches.models';
import { lockMessagingMatch } from './match-access';
import { enqueueNotification } from '../mobile/notification-outbox';

@Injectable()
export class MatchMessageRepository {
  constructor(private readonly database: DatabaseService) {}

  async messagesForUser(matchId: string, userId: string, limit: number, offset: number, cursor?: KeysetCursor): Promise<MatchCommandResult<CursorMessageRow[]>> {
    return this.database.transaction(async (client) => {
      const available = await lockMessagingMatch(client, matchId, userId);
      if (!available.ok) return available;
      const messages = await client.query<CursorMessageRow>(`
        SELECT id, match_id, sender_id, content, created_at, read_at,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
        FROM chat_message
        WHERE match_id = $1
          AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3
      `, [matchId, limit, offset, cursor?.at ?? null, cursor?.id ?? null]);
      return { ok: true, value: messages.rows };
    });
  }

  async createMessage(
    messageId: string,
    matchId: string,
    senderId: string,
    content: string,
    idempotencyKey: string,
  ): Promise<MessageCreationResult> {
    return this.database.transaction(async (client) => {
      const replay = await this.findIdempotentMessage(client, senderId, idempotencyKey);
      if (replay) {
        if (replay.message.match_id !== matchId || replay.message.content !== content) {
          return { ok: false, reason: 'idempotency_conflict' };
        }
        return { ok: true, value: { ...replay, created: false } };
      }
      const available = await lockMessagingMatch(client, matchId, senderId);
      if (!available.ok) return available;
      const inserted = await client.query<MessageRow>(`
        INSERT INTO chat_message (id, match_id, sender_id, content, idempotency_key, created_at)
        VALUES ($1, $2, $3, $4, $5, clock_timestamp())
        ON CONFLICT (sender_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
        RETURNING id, match_id, sender_id, content, created_at, read_at
      `, [messageId, matchId, senderId, content, idempotencyKey]);
      if (!inserted.rows[0]) {
        const concurrentReplay = await this.findIdempotentMessage(client, senderId, idempotencyKey);
        if (!concurrentReplay || concurrentReplay.message.match_id !== matchId || concurrentReplay.message.content !== content) {
          return { ok: false, reason: 'idempotency_conflict' };
        }
        return { ok: true, value: { ...concurrentReplay, created: false } };
      }
      const message = inserted.rows[0];
      await client.query('UPDATE match_init SET last_message_at = $2 WHERE id = $1', [matchId, message.created_at]);
      const recipientId = available.value.user1_id === senderId ? available.value.user2_id : available.value.user1_id;
      await enqueueNotification(client, recipientId, message.id, {
        type: 'new_message', matchId, messageId: message.id, senderId,
      });
      return {
        ok: true,
        value: { message, participant_ids: [available.value.user1_id, available.value.user2_id], created: true },
      };
    });
  }

  async markMessageRead(matchId: string, messageId: string, userId: string): Promise<MatchCommandResult<MessageRead | undefined>> {
    return this.database.transaction(async (client) => {
      const available = await lockMessagingMatch(client, matchId, userId);
      if (!available.ok) return available;
      const updated = await client.query(`
        UPDATE chat_message SET read_at = COALESCE(read_at, clock_timestamp())
        WHERE id = $1 AND match_id = $2 AND sender_id <> $3
      `, [messageId, matchId, userId]);
      if (updated.rowCount !== 1) return { ok: true, value: undefined };
      return { ok: true, value: {
        updated_count: 1,
        participant_ids: [available.value.user1_id, available.value.user2_id],
        read_through_message_id: messageId,
      } };
    });
  }

  async markMessagesReadThrough(
    matchId: string,
    messageId: string,
    userId: string,
  ): Promise<MatchCommandResult<MessageRead | undefined>> {
    return this.database.transaction(async (client) => {
      const available = await lockMessagingMatch(client, matchId, userId);
      if (!available.ok) return available;
      const result = await client.query<{ boundary_exists: boolean; updated_count: number }>(`
        WITH boundary AS (
          SELECT id, created_at
          FROM chat_message
          WHERE id = $2 AND match_id = $1
        ), updated AS (
          UPDATE chat_message AS message
          SET read_at = clock_timestamp()
          FROM boundary
          WHERE message.match_id = $1 AND message.sender_id <> $3
            AND message.read_at IS NULL
            AND (message.created_at, message.id) <= (boundary.created_at, boundary.id)
          RETURNING message.id
        )
        SELECT EXISTS (SELECT 1 FROM boundary) AS boundary_exists,
          count(*)::integer AS updated_count
        FROM updated
      `, [matchId, messageId, userId]);
      const update = result.rows[0]!;
      if (!update.boundary_exists) return { ok: true, value: undefined };
      return { ok: true, value: {
        updated_count: update.updated_count,
        participant_ids: [available.value.user1_id, available.value.user2_id],
        read_through_message_id: messageId,
      } };
    });
  }

  private async findIdempotentMessage(
    client: PoolClient,
    senderId: string,
    idempotencyKey: string,
  ): Promise<{ message: MessageRow; participant_ids: [string, string] } | undefined> {
    const row = (await client.query<MessageRow & Pick<MatchRow, 'user1_id' | 'user2_id'>>(`
      SELECT message.id, message.match_id, message.sender_id, message.content, message.created_at, message.read_at,
        match_record.user1_id, match_record.user2_id
      FROM chat_message AS message
      JOIN match_init AS match_record ON match_record.id = message.match_id
      WHERE message.sender_id = $1 AND message.idempotency_key = $2
    `, [senderId, idempotencyKey])).rows[0];
    if (!row) return undefined;
    return {
      message: {
        id: row.id,
        match_id: row.match_id,
        sender_id: row.sender_id,
        content: row.content,
        created_at: row.created_at,
        read_at: row.read_at,
      },
      participant_ids: [row.user1_id, row.user2_id],
    };
  }

}
