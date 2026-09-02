import type { MatchRow, MatchStatus, MessageRow, UserMatchRow } from './matches.models';
import type { ProfileAnswer } from '../profile-questions/profile-questions.models';

export type PublicMatch = {
  id: string;
  user1_id: string;
  user2_id: string;
  status: MatchStatus;
  expires_at: Date;
  purge_after?: Date;
  created_at: Date;
  last_message_at?: Date;
};

export type PublicMessage = {
  id: string;
  match_id: string;
  sender_id: string;
  content: string;
  created_at: Date;
  read_at?: Date;
};

export type PublicMatchUser = {
  user_id: string;
  firstname: string;
  age: number;
  sex: string | null;
  bio: string | null;
  traits: string[];
  photo: string | null;
  profile_answers: ProfileAnswer[];
};

export type PublicLastMessage = {
  id: string;
  sender_id: string;
  content: string;
  created_at: Date;
  read_at: Date | null;
};

export type PublicUserMatch = {
  id: string;
  status: MatchStatus;
  expires_at: Date;
  purge_after?: Date;
  created_at: Date;
  last_message_at?: Date;
  other_user: PublicMatchUser;
  my_revealed: boolean;
  photos_revealed: boolean;
  my_continued: boolean;
  unread_count: number;
  last_message: PublicLastMessage | null;
};

export function toPublicMatch(row: MatchRow): PublicMatch {
  const match: PublicMatch = {
    id: row.id,
    user1_id: row.user1_id,
    user2_id: row.user2_id,
    status: row.status,
    expires_at: row.expires_at,
    created_at: row.created_at,
  };
  if (row.purge_after !== null) match.purge_after = row.purge_after;
  if (row.last_message_at !== null) match.last_message_at = row.last_message_at;
  return match;
}

export function toPublicMessage(row: MessageRow): PublicMessage {
  const message: PublicMessage = {
    id: row.id,
    match_id: row.match_id,
    sender_id: row.sender_id,
    content: row.content,
    created_at: row.created_at,
  };
  if (row.read_at !== null) message.read_at = row.read_at;
  return message;
}

export function toPublicUserMatch(row: UserMatchRow, photoUrl: string | null): PublicUserMatch {
  const match: PublicUserMatch = {
    id: row.id,
    status: row.status,
    expires_at: row.expires_at,
    created_at: row.created_at,
    other_user: {
      user_id: row.other_user_id,
      firstname: row.other_firstname,
      age: row.other_age,
      sex: row.other_sex,
      bio: row.other_bio,
      traits: row.other_traits,
      photo: photoUrl,
      profile_answers: row.other_profile_answers ?? [],
    },
    my_revealed: row.my_revealed,
    photos_revealed: row.photos_revealed,
    my_continued: row.my_continued,
    unread_count: row.unread_count,
    last_message: row.last_message_id === null ? null : {
      id: row.last_message_id,
      sender_id: row.last_message_sender_id!,
      content: row.last_message_content!,
      created_at: row.last_message_created_at!,
      read_at: row.last_message_read_at,
    },
  };
  if (row.purge_after !== null) match.purge_after = row.purge_after;
  if (row.last_message_at !== null) match.last_message_at = row.last_message_at;
  return match;
}
