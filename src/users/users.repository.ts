import { Injectable } from '@nestjs/common';
import { enqueueAccountErasure, type AcceptedErasure } from '../privacy/erasure-enqueue';
import { DatabaseService, type Queryable } from '../database/database.service';
import { legalDocumentVersion, ONBOARDING_LEGAL_CHOICE_TYPES, type LegalDocumentVersions } from './users.models';
import type { ConsentChange, ConsentEvent, ConsentType, ModeratedProfileInput, PreferencesInput, PreferencesRow, PresenceInput, ProfileRow } from './users.models';

@Injectable()
export class UsersRepository {
  constructor(private readonly database: DatabaseService) {}

  async findProfile(userId: string): Promise<ProfileRow | undefined> {
    const result = await this.database.query<ProfileRow>(`
      SELECT profile.user_id, profile.firstname, profile.birthdate, profile.sex, profile.bio,
        photo.object_key AS photo,
        bio_moderation.status AS bio_moderation_status,
        bio_moderation.reason_codes AS bio_moderation_reasons,
        photo_moderation.status AS photo_moderation_status,
        photo_moderation.reason_codes AS photo_moderation_reasons,
        COALESCE(answers.items, '[]'::jsonb) AS profile_answers
      FROM user_profile AS profile
      JOIN user_account AS account ON account.user_id = profile.user_id
      LEFT JOIN user_photo AS photo
        ON photo.user_id = profile.user_id AND photo.status = 'ready'
      LEFT JOIN content_moderation_case AS bio_moderation
        ON bio_moderation.bio_user_id = profile.user_id
      LEFT JOIN content_moderation_case AS photo_moderation
        ON photo_moderation.photo_id = photo.id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'question_id', answer.question_id,
          'code', question.code,
          'question', question.prompt,
          'answer', answer.answer,
          'position', answer.position,
          'moderation_status', moderation.status,
          'moderation_reasons', moderation.reason_codes
        ) ORDER BY answer.position) AS items
        FROM user_profile_answer AS answer
        JOIN profile_question AS question ON question.id = answer.question_id
        JOIN content_moderation_case AS moderation
          ON moderation.profile_answer_id = answer.id
        WHERE answer.user_id = profile.user_id
      ) AS answers ON true
      WHERE profile.user_id = $1 AND account.deleted_at IS NULL
    `, [userId]);
    return result.rows[0];
  }

  async upsertProfile(userId: string, input: ModeratedProfileInput, versions: LegalDocumentVersions): Promise<boolean> {
    return this.database.transaction(async (client) => {
      if (!await this.lockLegalChoices(client, userId, input.sex === null ? undefined : 'sensitive_data_consent', versions)) return false;
      const current = (await client.query<{ bio: string | null }>(`
        SELECT bio FROM user_profile WHERE user_id = $1 FOR UPDATE
      `, [userId])).rows[0];
      const result = await client.query(`
        INSERT INTO user_profile (user_id, firstname, birthdate, sex, bio)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id) DO UPDATE SET firstname = EXCLUDED.firstname, birthdate = EXCLUDED.birthdate,
          sex = EXCLUDED.sex, bio = EXCLUDED.bio
      `, [userId, input.firstname, input.birthdate, input.sex, input.bio]);
      if (result.rowCount === 0) return false;
      if (input.bio === null || input.bio === '') {
        await client.query('DELETE FROM content_moderation_case WHERE bio_user_id = $1', [userId]);
      } else if (current?.bio !== input.bio || !current) {
        const decision = input.bioModeration!;
        await client.query(`
          INSERT INTO content_moderation_case (
            user_id, content_type, bio_user_id, status, reason_codes, policy_version
          ) VALUES ($1, 'bio', $1, $2, $3, $4)
          ON CONFLICT (bio_user_id) WHERE bio_user_id IS NOT NULL DO UPDATE
          SET status = EXCLUDED.status, reason_codes = EXCLUDED.reason_codes,
            policy_version = EXCLUDED.policy_version, version = content_moderation_case.version + 1,
            reviewed_by = NULL, reviewed_at = NULL, review_reason = NULL,
            updated_at = clock_timestamp()
        `, [userId, decision.status, decision.reasonCodes, decision.policyVersion]);
      }
      return true;
    });
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

  async upsertPreferences(userId: string, input: PreferencesInput, versions: LegalDocumentVersions): Promise<boolean> {
    return this.database.transaction(async client => {
      if (!await this.lockLegalChoices(client, userId, 'sensitive_data_consent', versions)) return false;
      const result = await client.query(`
        INSERT INTO user_preferences (user_id, min_age, max_age, max_distance_km, looking_for)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id) DO UPDATE SET min_age = EXCLUDED.min_age, max_age = EXCLUDED.max_age,
          max_distance_km = EXCLUDED.max_distance_km, looking_for = EXCLUDED.looking_for
      `, [userId, input.min_age, input.max_age, input.max_distance_km, input.looking_for]);
      return result.rowCount !== 0;
    });
  }

  async upsertPresence(userId: string, input: PresenceInput, updatedAt: Date, versions: LegalDocumentVersions): Promise<boolean> {
    return this.database.transaction(async client => {
      if (!await this.lockLegalChoices(client, userId, 'location_consent', versions)) return false;
      const result = await client.query(`
        INSERT INTO user_presence (user_id, latitude, longitude, is_location_fresh, updated_at)
        VALUES ($1, $2, $3, true, $4)
        ON CONFLICT (user_id) DO UPDATE SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
          is_location_fresh = EXCLUDED.is_location_fresh, updated_at = EXCLUDED.updated_at
      `, [userId, input.latitude, input.longitude, updatedAt]);
      return result.rowCount !== 0;
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

  async acceptErasure(userId: string, id: string, tokenHash: string, now: Date): Promise<AcceptedErasure | undefined> {
    return this.database.transaction(async (client) => {
      const account = await client.query(`SELECT user_id FROM user_account
        WHERE user_id = $1 AND deleted_at IS NULL FOR UPDATE`, [userId]);
      if (!account.rows[0]) return undefined;
      const consumed = await client.query(`DELETE FROM account_deletion_token
        WHERE id = $1 AND user_id = $2 AND token_hash = $3 AND expires_at > $4`, [id, userId, tokenHash, now]);
      if (consumed.rowCount !== 1) return undefined;
      return enqueueAccountErasure(client, userId);
    });
  }

  async activeLegalChoices(userId: string, consentTypes: ConsentType[], database: Queryable = this.database): Promise<Array<{ consent_type: ConsentType; document_version: string }>> {
    if (!consentTypes.length) return [];
    return (await database.query<{ consent_type: ConsentType; document_version: string }>(`
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

  private async lockLegalChoices(client: Queryable, userId: string, sensitive: 'sensitive_data_consent' | 'location_consent' | undefined, versions: LegalDocumentVersions): Promise<boolean> {
    // Same account-first lock order as recordConsents and account erasure. A
    // preflight HTTP check alone cannot authorize a later sensitive write.
    const account = await client.query('SELECT user_id FROM user_account WHERE user_id=$1 AND deleted_at IS NULL FOR UPDATE', [userId]);
    if (!account.rows[0]) return false;
    const required: ConsentType[] = [...ONBOARDING_LEGAL_CHOICE_TYPES, ...(sensitive ? [sensitive] : [])];
    const current = new Map((await this.activeLegalChoices(userId, required, client)).map(row => [row.consent_type, row.document_version]));
    if (required.some(type => current.get(type) !== legalDocumentVersion(type, versions))) throw new RequiredConsentMissingError();
    return true;
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

export class RequiredConsentMissingError extends Error {}
