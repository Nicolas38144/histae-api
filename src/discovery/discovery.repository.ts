import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { DiscoveryCandidateRow, DiscoveryCursor, DiscoveryStatusRow } from './discovery.models';

@Injectable()
export class DiscoveryRepository {
  constructor(private readonly database: DatabaseService) {}

  async discoveryStatus(userId: string, sensitiveVersion: string, locationVersion: string): Promise<DiscoveryStatusRow> {
    return (await this.database.query<DiscoveryStatusRow>(`
      SELECT
        EXISTS (SELECT 1 FROM user_profile WHERE user_id = $1) AS has_profile,
        EXISTS (SELECT 1 FROM user_profile WHERE user_id = $1 AND sex IS NOT NULL) AS has_sex,
        EXISTS (SELECT 1 FROM user_preferences WHERE user_id = $1) AS has_preferences,
        EXISTS (
          SELECT 1 FROM user_consent WHERE user_id = $1
            AND consent_type = 'sensitive_data_consent' AND granted = true
            AND withdrawn_at IS NULL AND document_version = $2
        ) AS has_sensitive_consent,
        EXISTS (
          SELECT 1 FROM user_consent WHERE user_id = $1
            AND consent_type = 'location_consent' AND granted = true
            AND withdrawn_at IS NULL AND document_version = $3
        ) AS has_location_consent,
        EXISTS (
          SELECT 1 FROM user_presence WHERE user_id = $1 AND is_location_fresh = true
            AND updated_at > clock_timestamp() - INTERVAL '1 hour'
        ) AS has_fresh_presence,
        (SELECT updated_at + INTERVAL '1 hour' FROM user_presence WHERE user_id = $1) AS presence_expires_at
    `, [userId, sensitiveVersion, locationVersion])).rows[0]!;
  }

  async isDiscoveryReady(userId: string, sensitiveVersion: string, locationVersion: string): Promise<boolean> {
    const result = await this.database.query<{ ready: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM user_account AS account
        JOIN user_profile AS profile ON profile.user_id = account.user_id AND profile.sex IS NOT NULL
        JOIN user_preferences AS preferences ON preferences.user_id = account.user_id
        JOIN user_presence AS presence ON presence.user_id = account.user_id
          AND presence.is_location_fresh = true
          AND presence.updated_at > clock_timestamp() - INTERVAL '1 hour'
        WHERE account.user_id = $1 AND account.deleted_at IS NULL AND account.is_banned = false
          AND EXISTS (
            SELECT 1 FROM user_consent
            WHERE user_id = account.user_id AND consent_type = 'sensitive_data_consent'
              AND granted = true AND withdrawn_at IS NULL AND document_version = $2
          )
          AND EXISTS (
            SELECT 1 FROM user_consent
            WHERE user_id = account.user_id AND consent_type = 'location_consent'
              AND granted = true AND withdrawn_at IS NULL AND document_version = $3
          )
      ) AS ready
    `, [userId, sensitiveVersion, locationVersion]);
    return result.rows[0]?.ready === true;
  }

  async isSwipeTargetAvailable(
    actorId: string,
    targetId: string,
    sensitiveVersion: string,
    locationVersion: string,
  ): Promise<boolean> {
    return (await this.candidateBatch(
      actorId,
      sensitiveVersion,
      locationVersion,
      1,
      undefined,
      targetId,
    )).length === 1;
  }

  async candidateBatch(
    userId: string,
    sensitiveVersion: string,
    locationVersion: string,
    limit: number,
    cursor?: DiscoveryCursor,
    targetId?: string,
  ): Promise<DiscoveryCandidateRow[]> {
    const result = await this.database.query<DiscoveryCandidateRow>(`
      WITH viewer AS (
        SELECT profile.birthdate, profile.sex, preferences.min_age, preferences.max_age,
          preferences.max_distance_km, preferences.looking_for,
          presence.latitude::double precision AS latitude,
          presence.longitude::double precision AS longitude
        FROM user_account AS account
        JOIN user_profile AS profile ON profile.user_id = account.user_id AND profile.sex IS NOT NULL
        JOIN user_preferences AS preferences ON preferences.user_id = account.user_id
        JOIN user_presence AS presence ON presence.user_id = account.user_id
        WHERE account.user_id = $1 AND account.deleted_at IS NULL AND account.is_banned = false
          AND presence.is_location_fresh = true
          AND presence.updated_at > clock_timestamp() - INTERVAL '1 hour'
          AND EXISTS (
            SELECT 1 FROM user_consent
            WHERE user_id = account.user_id AND consent_type = 'sensitive_data_consent'
              AND granted = true AND withdrawn_at IS NULL AND document_version = $2
          )
          AND EXISTS (
            SELECT 1 FROM user_consent
            WHERE user_id = account.user_id AND consent_type = 'location_consent'
              AND granted = true AND withdrawn_at IS NULL AND document_version = $3
          )
      ), candidates AS (
        SELECT target.user_id, target.firstname,
          date_part('year', age(current_date, target.birthdate))::integer AS age,
          target.sex,
          CASE WHEN bio_moderation.status = 'approved' THEN target.bio ELSE NULL END AS bio,
          (6371.0088 * 2 * asin(sqrt(least(1.0, greatest(0.0,
            power(sin(radians((target_presence.latitude::double precision - viewer.latitude) / 2)), 2)
            + cos(radians(viewer.latitude)) * cos(radians(target_presence.latitude::double precision))
            * power(sin(radians((target_presence.longitude::double precision - viewer.longitude) / 2)), 2)
          )))))::double precision AS distance_km,
          COALESCE(traits.names, ARRAY[]::text[]) AS traits,
          COALESCE(answers.items, '[]'::jsonb) AS profile_answers,
          viewer.max_distance_km AS viewer_max_distance_km,
          target_preferences.max_distance_km AS target_max_distance_km
        FROM viewer
        JOIN user_profile AS target ON target.user_id <> $1 AND target.sex IS NOT NULL
          AND ($7::uuid IS NULL OR target.user_id = $7)
        JOIN user_account AS target_account ON target_account.user_id = target.user_id
          AND target_account.deleted_at IS NULL AND target_account.is_banned = false
        JOIN user_preferences AS target_preferences ON target_preferences.user_id = target.user_id
        JOIN user_presence AS target_presence ON target_presence.user_id = target.user_id
          AND target_presence.is_location_fresh = true
          AND target_presence.updated_at > clock_timestamp() - INTERVAL '1 hour'
        LEFT JOIN content_moderation_case AS bio_moderation
          ON bio_moderation.bio_user_id = target.user_id
        LEFT JOIN LATERAL (
          SELECT array_agg(trait.name ORDER BY trait.name) AS names
          FROM user_trait JOIN trait ON trait.id = user_trait.trait_id
          WHERE user_trait.user_id = target.user_id
        ) AS traits ON true
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object(
            'question_id', answer.question_id,
            'code', question.code,
            'question', question.prompt,
            'answer', answer.answer,
            'position', answer.position
          ) ORDER BY answer.position) AS items
          FROM user_profile_answer AS answer
          JOIN profile_question AS question ON question.id = answer.question_id
          JOIN content_moderation_case AS moderation
            ON moderation.profile_answer_id = answer.id AND moderation.status = 'approved'
          WHERE answer.user_id = target.user_id
        ) AS answers ON true
        WHERE target_presence.latitude::double precision BETWEEN
            viewer.latitude - viewer.max_distance_km / 111.0
            AND viewer.latitude + viewer.max_distance_km / 111.0
          AND (
            abs(target_presence.longitude::double precision - viewer.longitude)
              <= viewer.max_distance_km / (111.0 * greatest(abs(cos(radians(viewer.latitude))), 0.01))
            OR abs(target_presence.longitude::double precision - viewer.longitude)
              >= 360.0 - viewer.max_distance_km / (111.0 * greatest(abs(cos(radians(viewer.latitude))), 0.01))
          )
          AND date_part('year', age(current_date, target.birthdate))::integer BETWEEN viewer.min_age AND viewer.max_age
          AND date_part('year', age(current_date, viewer.birthdate))::integer
            BETWEEN target_preferences.min_age AND target_preferences.max_age
          AND (viewer.looking_for = target.sex OR (viewer.looking_for = 'both' AND target.sex IN ('male', 'female')))
          AND (target_preferences.looking_for = viewer.sex
            OR (target_preferences.looking_for = 'both' AND viewer.sex IN ('male', 'female')))
          AND EXISTS (
            SELECT 1 FROM user_consent
            WHERE user_id = target.user_id AND consent_type = 'sensitive_data_consent'
              AND granted = true AND withdrawn_at IS NULL AND document_version = $2
          )
          AND EXISTS (
            SELECT 1 FROM user_consent
            WHERE user_id = target.user_id AND consent_type = 'location_consent'
              AND granted = true AND withdrawn_at IS NULL AND document_version = $3
          )
          AND NOT EXISTS (
            SELECT 1 FROM user_block
            WHERE (blocker_id = $1 AND blocked_id = target.user_id)
               OR (blocker_id = target.user_id AND blocked_id = $1)
          )
          AND NOT EXISTS (
            SELECT 1 FROM match_init
            WHERE (user1_id = $1 AND user2_id = target.user_id)
               OR (user1_id = target.user_id AND user2_id = $1)
          )
      )
      SELECT user_id, firstname, age, sex, bio, distance_km, traits, profile_answers
      FROM candidates
      WHERE distance_km <= least(viewer_max_distance_km, target_max_distance_km)
        AND ($4::double precision IS NULL OR (distance_km, user_id) > ($4::double precision, $5::uuid))
      ORDER BY distance_km, user_id
      LIMIT $6
    `, [userId, sensitiveVersion, locationVersion, cursor?.distance_km ?? null, cursor?.id ?? null, limit, targetId ?? null]);
    return result.rows.map((row) => ({
      ...row,
      distance_km: Number(row.distance_km),
      traits: row.traits ?? [],
      profile_answers: row.profile_answers ?? [],
    }));
  }
}
