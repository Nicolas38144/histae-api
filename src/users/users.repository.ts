import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { ConsentChange, ConsentEvent, ConsentType, PreferencesInput, PreferencesRow, PresenceInput, ProfileInput, ProfileRow } from './users.models';

@Injectable()
export class UsersRepository {
  constructor(private readonly database: DatabaseService) {}

  async findProfile(userId: string): Promise<ProfileRow | undefined> {
    const result = await this.database.query<ProfileRow>(`
      SELECT profile.user_id, profile.firstname, profile.birthdate, profile.sex, profile.bio, profile.photo
      FROM user_profile AS profile
      JOIN user_account AS account ON account.user_id = profile.user_id
      WHERE profile.user_id = $1 AND account.deleted_at IS NULL
    `, [userId]);
    return result.rows[0];
  }

  async upsertProfile(userId: string, input: ProfileInput): Promise<boolean> {
    const result = await this.database.query(`
      INSERT INTO user_profile (user_id, firstname, birthdate, sex, bio, photo)
      SELECT $1, $2, $3, $4, $5, $6 WHERE EXISTS (
        SELECT 1 FROM user_account WHERE user_id = $1 AND deleted_at IS NULL
      )
      ON CONFLICT (user_id) DO UPDATE SET firstname = EXCLUDED.firstname, birthdate = EXCLUDED.birthdate,
        sex = EXCLUDED.sex, bio = EXCLUDED.bio, photo = EXCLUDED.photo
    `, [userId, input.firstname, input.birthdate, input.sex, input.bio, input.photo]);
    return result.rowCount !== 0;
  }

  async findPreferences(userId: string): Promise<PreferencesRow | undefined> {
    const result = await this.database.query<PreferencesRow>(`
      SELECT preferences.user_id, preferences.min_age, preferences.max_age, preferences.max_distance_km, preferences.looking_for
      FROM user_preferences AS preferences
      JOIN user_account AS account ON account.user_id = preferences.user_id
      WHERE preferences.user_id = $1 AND account.deleted_at IS NULL
    `, [userId]);
    return result.rows[0];
  }

  async upsertPreferences(userId: string, input: PreferencesInput): Promise<boolean> {
    const result = await this.database.query(`
      INSERT INTO user_preferences (user_id, min_age, max_age, max_distance_km, looking_for)
      SELECT $1, $2, $3, $4, $5 WHERE EXISTS (
        SELECT 1 FROM user_account WHERE user_id = $1 AND deleted_at IS NULL
      )
      ON CONFLICT (user_id) DO UPDATE SET min_age = EXCLUDED.min_age, max_age = EXCLUDED.max_age,
        max_distance_km = EXCLUDED.max_distance_km, looking_for = EXCLUDED.looking_for
    `, [userId, input.min_age, input.max_age, input.max_distance_km, input.looking_for]);
    return result.rowCount !== 0;
  }

  async upsertPresence(userId: string, input: PresenceInput, updatedAt: Date): Promise<boolean> {
    const result = await this.database.query(`
      INSERT INTO user_presence (user_id, latitude, longitude, is_location_fresh, updated_at)
      SELECT $1, $2, $3, true, $4 WHERE EXISTS (
        SELECT 1 FROM user_account WHERE user_id = $1 AND deleted_at IS NULL
      )
      ON CONFLICT (user_id) DO UPDATE SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
        is_location_fresh = EXCLUDED.is_location_fresh, updated_at = EXCLUDED.updated_at
    `, [userId, input.latitude, input.longitude, updatedAt]);
    return result.rowCount !== 0;
  }

  async anonymize(userId: string): Promise<void> {
    await this.database.transaction(async (client) => {
      await client.query('DELETE FROM account_deletion_token WHERE user_id = $1', [userId]);
      await client.query('SELECT fct_anonymize_user($1)', [userId]);
    });
  }

  async replaceDeletionToken(userId: string, id: string, tokenHash: string, expiresAt: Date): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const account = await client.query<{ user_id: string }>(`
        SELECT user_id FROM user_account WHERE user_id = $1 AND deleted_at IS NULL FOR UPDATE
      `, [userId]);
      if (!account.rows[0]) return false;
      await client.query('DELETE FROM account_deletion_token WHERE user_id = $1', [userId]);
      await client.query(`
        INSERT INTO account_deletion_token (id, user_id, token_hash, expires_at)
        VALUES ($1, $2, $3, $4)
      `, [id, userId, tokenHash, expiresAt]);
      return true;
    });
  }

  async consumeDeletionToken(userId: string, id: string, tokenHash: string, now: Date): Promise<boolean> {
    return (await this.database.query(`
      DELETE FROM account_deletion_token
      WHERE id = $1 AND user_id = $2 AND token_hash = $3 AND expires_at > $4
    `, [id, userId, tokenHash, now])).rowCount === 1;
  }

  async activeLegalChoices(userId: string, consentTypes: ConsentType[]): Promise<Array<{ consent_type: ConsentType; document_version: string }>> {
    if (!consentTypes.length) return [];
    return (await this.database.query<{ consent_type: ConsentType; document_version: string }>(`
      SELECT consent_type, document_version FROM user_consent
      WHERE user_id = $1 AND consent_type = ANY($2::text[]) AND granted = true AND withdrawn_at IS NULL
    `, [userId, consentTypes])).rows;
  }

  async currentConsents(userId: string): Promise<ConsentEvent[]> {
    return (await this.database.query<ConsentEvent>(`
      SELECT DISTINCT ON (consent_type) consent_type, granted, document_version, granted_at, withdrawn_at
      FROM user_consent WHERE user_id = $1
      ORDER BY consent_type, event_sequence DESC
    `, [userId])).rows;
  }

  async recordConsents(
    userId: string,
    changes: Array<ConsentChange & { document_version: string }>,
    ipAddress: string,
    userAgent: string,
  ): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const account = await client.query<{ user_id: string }>(`
        SELECT user_id FROM user_account WHERE user_id = $1 AND deleted_at IS NULL FOR UPDATE
      `, [userId]);
      if (!account.rows[0]) return false;

      for (const change of changes) {
        const current = await client.query<{ granted: boolean; document_version: string }>(`
          SELECT granted, document_version
          FROM user_consent
          WHERE user_id = $1 AND consent_type = $2
          ORDER BY event_sequence DESC
          LIMIT 1
        `, [userId, change.consent_type]);
        if (current.rows[0]?.granted === change.granted
          && current.rows[0].document_version === change.document_version) continue;

        await client.query(`
          UPDATE user_consent SET withdrawn_at = clock_timestamp()
          WHERE user_id = $1 AND consent_type = $2 AND granted = true AND withdrawn_at IS NULL
        `, [userId, change.consent_type]);
        await client.query(`
          INSERT INTO user_consent (user_id, consent_type, granted, document_version, ip_address, user_agent, granted_at, withdrawn_at)
          VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp(), CASE WHEN $3 THEN NULL ELSE clock_timestamp() END)
        `, [userId, change.consent_type, change.granted, change.document_version, ipAddress || null, userAgent || null]);

        if (!change.granted && change.consent_type === 'sensitive_data_consent') {
          await client.query('UPDATE user_profile SET sex = NULL WHERE user_id = $1', [userId]);
          await client.query('DELETE FROM user_preferences WHERE user_id = $1', [userId]);
        }
        if (!change.granted && change.consent_type === 'location_consent') {
          await client.query('DELETE FROM user_presence WHERE user_id = $1', [userId]);
        }
      }
      return true;
    });
  }

}
