import type { ProfileRow, Sex } from './users.models';
import type { ProfileAnswer } from '../profile-questions/profile-questions.models';
import type { ModerationReasonCode, ModerationStatus } from '../moderation/moderation.models';

export type PublicProfile = {
  user_id: string;
  firstname: string;
  birthdate: string;
  sex?: Sex;
  bio?: string;
  photo?: string;
  profile_answers: ProfileAnswer[];
  moderation: {
    bio: { status: ModerationStatus; reasons: ModerationReasonCode[] } | null;
    photo: { status: ModerationStatus; reasons: ModerationReasonCode[] } | null;
  };
};

export function toPublicProfile(row: ProfileRow, photoUrl: string | null): PublicProfile {
  const profile: PublicProfile = {
    user_id: row.user_id,
    firstname: row.firstname,
    birthdate: row.birthdate instanceof Date ? row.birthdate.toISOString().slice(0, 10) : String(row.birthdate).slice(0, 10),
    profile_answers: row.profile_answers ?? [],
    moderation: {
      bio: row.bio_moderation_status ? {
        status: row.bio_moderation_status,
        reasons: row.bio_moderation_reasons ?? [],
      } : null,
      photo: row.photo_moderation_status ? {
        status: row.photo_moderation_status,
        reasons: row.photo_moderation_reasons ?? [],
      } : null,
    },
  };
  if (row.sex !== null) profile.sex = row.sex;
  if (row.bio !== null) profile.bio = row.bio;
  if (photoUrl !== null) profile.photo = photoUrl;
  return profile;
}
