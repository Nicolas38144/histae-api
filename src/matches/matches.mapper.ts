import type { MatchRow, MatchStatus, MessageRow } from './matches.models';

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
