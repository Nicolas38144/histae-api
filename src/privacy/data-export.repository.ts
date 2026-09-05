import { Injectable } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';

import { DatabaseService } from '../database/database.service';
import { JsonExportWriter } from './json-export.writer';

type ExportObject = QueryResultRow & Record<string, unknown>;
type TimestampCursor = { at: string; id: string };

export type PostgresExportSnapshot = {
  snapshotAt: Date;
  account: ExportObject | null;
  profile: ExportObject | null;
  photoKey: string | null;
  preferences: ExportObject | null;
  subscription: ExportObject | null;
};

@Injectable()
export class DataExportRepository {
  constructor(private readonly database: DatabaseService) {}

  writeSnapshot(
    userId: string,
    writer: JsonExportWriter,
    pageSize: number,
  ): Promise<PostgresExportSnapshot> {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const snapshotAt = (await client.query<{ snapshot_at: Date }>(
        'SELECT transaction_timestamp() AS snapshot_at',
      )).rows[0]!.snapshot_at;
      const account = (await client.query<ExportObject>(`
        SELECT user_id, role, is_banned, deleted_at, anonymized_at, created_at
        FROM user_account WHERE user_id = $1
      `, [userId])).rows[0] ?? null;
      const storedProfile = (await client.query<ExportObject & { photo_key: string | null }>(`
        SELECT profile.firstname, profile.birthdate, profile.sex, profile.bio,
          photo.object_key AS photo_key
        FROM user_profile AS profile
        LEFT JOIN user_photo AS photo
          ON photo.user_id = profile.user_id AND photo.status = 'ready'
        WHERE profile.user_id = $1
      `, [userId])).rows[0] ?? null;
      const preferences = (await client.query<ExportObject>(`
        SELECT min_age, max_age, max_distance_km, looking_for
        FROM user_preferences WHERE user_id = $1
      `, [userId])).rows[0] ?? null;
      const subscription = (await client.query<ExportObject>(`
        SELECT plan, provider, provider_subscription_id, provider_price_id, billing_period, status,
          cancel_at_period_end, current_period_starts_at, current_period_ends_at,
          trial_ends_at, canceled_at, provider_event_created_at, updated_at
        FROM user_subscription WHERE user_id = $1
      `, [userId])).rows[0] ?? null;

      await this.writeTraits(client, writer, userId, pageSize);
      await this.writeProfileAnswers(client, writer, userId);
      await this.writeConsents(client, writer, userId, pageSize);
      await this.writeMatches(client, writer, userId, pageSize);
      await this.writeMessages(client, writer, userId, pageSize);
      await this.writeReports(client, writer, userId, pageSize);
      await this.writeBlocks(client, writer, userId, pageSize);
      await this.writeInvoices(client, writer, userId, pageSize);
      await this.writeMobileSessions(client, writer, userId, pageSize);

      const { photo_key: photoKey, ...profile } = storedProfile ?? { photo_key: null };
      return {
        snapshotAt,
        account,
        profile: storedProfile ? profile : null,
        photoKey,
        preferences,
        subscription,
      };
    });
  }

  private writeTraits(
    client: PoolClient,
    writer: JsonExportWriter,
    userId: string,
    pageSize: number,
  ): Promise<void> {
    return this.writePages(
      writer,
      'traits',
      pageSize,
      async (cursor: { name: string; id: string } | undefined) => (await client.query<ExportObject & {
        id: string;
        name: string;
      }>(`
        SELECT trait.id, trait.name
        FROM trait JOIN user_trait ON user_trait.trait_id = trait.id
        WHERE user_trait.user_id = $1
          AND ($2::text IS NULL OR (trait.name, trait.id) > ($2, $3::uuid))
        ORDER BY trait.name, trait.id LIMIT $4
      `, [userId, cursor?.name ?? null, cursor?.id ?? null, pageSize])).rows,
      (row) => ({ name: row.name, id: row.id }),
    );
  }

  private async writeProfileAnswers(
    client: PoolClient,
    writer: JsonExportWriter,
    userId: string,
  ): Promise<void> {
    const rows = (await client.query<ExportObject>(`
      SELECT answer.question_id, question.code, question.prompt AS question,
        answer.answer, answer.position
      FROM user_profile_answer AS answer
      JOIN profile_question AS question ON question.id = answer.question_id
      WHERE answer.user_id = $1 ORDER BY answer.position
    `, [userId])).rows;
    await writer.startArray('profile_answers');
    for (const row of rows) await writer.item(row);
    await writer.endArray();
  }

  private writeConsents(
    client: PoolClient,
    writer: JsonExportWriter,
    userId: string,
    pageSize: number,
  ): Promise<void> {
    return this.writePages(
      writer,
      'legal_choices',
      pageSize,
      async (cursor: string | undefined) => (await client.query<ExportObject & { event_sequence: string }>(`
        SELECT event_sequence::text, consent_type, granted, document_version, granted_at, withdrawn_at
        FROM user_consent
        WHERE user_id = $1 AND ($2::bigint IS NULL OR event_sequence > $2)
        ORDER BY event_sequence LIMIT $3
      `, [userId, cursor ?? null, pageSize])).rows,
      (row) => row.event_sequence,
      ({ event_sequence: _eventSequence, ...row }) => row,
    );
  }

  private writeMatches(
    client: PoolClient,
    writer: JsonExportWriter,
    userId: string,
    pageSize: number,
  ): Promise<void> {
    return this.writePages(
      writer,
      'matches',
      pageSize,
      async (cursor: TimestampCursor | undefined) => (await client.query<ExportObject & {
        id: string;
        cursor_at: string;
      }>(`
        WITH participant_matches AS (
          SELECT id, user1_id, user2_id, status, expires_at, created_at, last_message_at
          FROM match_init
          WHERE user1_id = $1
            AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
          UNION ALL
          SELECT id, user1_id, user2_id, status, expires_at, created_at, last_message_at
          FROM match_init
          WHERE user2_id = $1
            AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
        )
        SELECT participant_matches.*,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
        FROM participant_matches ORDER BY created_at, id LIMIT $4
      `, [userId, cursor?.at ?? null, cursor?.id ?? null, pageSize])).rows,
      (row) => ({ at: row.cursor_at, id: row.id }),
      withoutCursorAt,
    );
  }

  private writeMessages(
    client: PoolClient,
    writer: JsonExportWriter,
    userId: string,
    pageSize: number,
  ): Promise<void> {
    return this.writeTimestampPages(client, writer, 'authored_messages', userId, pageSize, `
      SELECT id, match_id, content, created_at, read_at,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM chat_message WHERE sender_id = $1
        AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
      ORDER BY created_at, id LIMIT $4
    `);
  }

  private writeReports(
    client: PoolClient,
    writer: JsonExportWriter,
    userId: string,
    pageSize: number,
  ): Promise<void> {
    return this.writeTimestampPages(client, writer, 'submitted_reports', userId, pageSize, `
      SELECT id, reported_id, match_id, reason, description, status, created_at, resolved_at,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM user_report WHERE reporter_id = $1
        AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
      ORDER BY created_at, id LIMIT $4
    `);
  }

  private writeBlocks(
    client: PoolClient,
    writer: JsonExportWriter,
    userId: string,
    pageSize: number,
  ): Promise<void> {
    return this.writePages(
      writer,
      'blocked_users',
      pageSize,
      async (cursor: TimestampCursor | undefined) => (await client.query<ExportObject & {
        blocked_id: string;
        cursor_at: string;
      }>(`
        SELECT blocked_id, created_at,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
        FROM user_block WHERE blocker_id = $1
          AND ($2::timestamptz IS NULL OR (created_at, blocked_id) > ($2::timestamptz, $3::uuid))
        ORDER BY created_at, blocked_id LIMIT $4
      `, [userId, cursor?.at ?? null, cursor?.id ?? null, pageSize])).rows,
      (row) => ({ at: row.cursor_at, id: row.blocked_id }),
      withoutCursorAt,
    );
  }

  private writeInvoices(
    client: PoolClient,
    writer: JsonExportWriter,
    userId: string,
    pageSize: number,
  ): Promise<void> {
    return this.writePages(
      writer,
      'billing_invoices',
      pageSize,
      async (cursor: TimestampCursor | undefined) => (await client.query<ExportObject & {
        stripe_invoice_id: string;
        cursor_at: string;
      }>(`
        SELECT stripe_invoice_id, stripe_subscription_id, status, currency, amount_due,
          amount_paid, amount_remaining, period_starts_at, period_ends_at, paid_at,
          created_at, provider_event_created_at,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
        FROM billing_invoice WHERE user_id = $1
          AND ($2::timestamptz IS NULL OR (created_at, stripe_invoice_id) > ($2::timestamptz, $3))
        ORDER BY created_at, stripe_invoice_id LIMIT $4
      `, [userId, cursor?.at ?? null, cursor?.id ?? null, pageSize])).rows,
      (row) => ({ at: row.cursor_at, id: row.stripe_invoice_id }),
      withoutCursorAt,
    );
  }

  private writeMobileSessions(
    client: PoolClient,
    writer: JsonExportWriter,
    userId: string,
    pageSize: number,
  ): Promise<void> {
    return this.writeTimestampPages(client, writer, 'mobile_sessions', userId, pageSize, `
      SELECT id, created_at, last_refreshed_at, expires_at, revoked_at, revocation_reason,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM refresh_token_family WHERE user_id = $1
        AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
      ORDER BY created_at, id LIMIT $4
    `);
  }

  private writeTimestampPages(
    client: PoolClient,
    writer: JsonExportWriter,
    name: string,
    userId: string,
    pageSize: number,
    sql: string,
  ): Promise<void> {
    return this.writePages(
      writer,
      name,
      pageSize,
      async (cursor: TimestampCursor | undefined) => (await client.query<ExportObject & {
        id: string;
        cursor_at: string;
      }>(sql, [userId, cursor?.at ?? null, cursor?.id ?? null, pageSize])).rows,
      (row) => ({ at: row.cursor_at, id: row.id }),
      withoutCursorAt,
    );
  }

  private async writePages<T extends ExportObject, Cursor>(
    writer: JsonExportWriter,
    name: string,
    pageSize: number,
    load: (cursor: Cursor | undefined) => Promise<T[]>,
    nextCursor: (row: T) => Cursor,
    publicRow: (row: T) => unknown = (row) => row,
  ): Promise<void> {
    await writer.startArray(name);
    let cursor: Cursor | undefined;
    while (true) {
      const rows = await load(cursor);
      for (const row of rows) await writer.item(publicRow(row));
      if (rows.length < pageSize) break;
      cursor = nextCursor(rows.at(-1)!);
    }
    await writer.endArray();
  }
}

function withoutCursorAt<T extends ExportObject & { cursor_at: string }>(row: T): Omit<T, 'cursor_at'> {
  const { cursor_at: _cursorAt, ...item } = row;
  void _cursorAt;
  return item;
}
