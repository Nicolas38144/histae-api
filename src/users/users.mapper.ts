import type { ProfileRow, Sex } from './users.models';

export type PublicProfile = {
  user_id: string;
  firstname: string;
  birthdate: string;
  sex?: Sex;
  bio?: string;
  photo?: string;
};

export function toPublicProfile(row: ProfileRow): PublicProfile {
  const profile: PublicProfile = {
    user_id: row.user_id,
    firstname: row.firstname,
    birthdate: row.birthdate instanceof Date ? row.birthdate.toISOString().slice(0, 10) : String(row.birthdate).slice(0, 10),
  };
  if (row.sex !== null) profile.sex = row.sex;
  if (row.bio !== null) profile.bio = row.bio;
  if (row.photo !== null) profile.photo = row.photo;
  return profile;
}
