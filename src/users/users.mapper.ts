import type { ProfileRow, Sex } from './users.models';
import type { ProfileAnswer } from '../profile-questions/profile-questions.models';

export type PublicProfile = {
  user_id: string;
  firstname: string;
  birthdate: string;
  sex?: Sex;
  bio?: string;
  photo?: string;
  profile_answers: ProfileAnswer[];
};

export function toPublicProfile(row: ProfileRow, photoUrl: string | null): PublicProfile {
  const profile: PublicProfile = {
    user_id: row.user_id,
    firstname: row.firstname,
    birthdate: row.birthdate instanceof Date ? row.birthdate.toISOString().slice(0, 10) : String(row.birthdate).slice(0, 10),
    profile_answers: row.profile_answers ?? [],
  };
  if (row.sex !== null) profile.sex = row.sex;
  if (row.bio !== null) profile.bio = row.bio;
  if (photoUrl !== null) profile.photo = photoUrl;
  return profile;
}
