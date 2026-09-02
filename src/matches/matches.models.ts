import type { ProfileAnswer } from '../profile-questions/profile-questions.models';

export const MATCH_STATUSES = ['awaiting_continuation', 'active', 'confirmed', 'expired', 'ended'] as const;
export type MatchStatus = typeof MATCH_STATUSES[number];

export type MatchRow = {
  id: string;
  user1_id: string;
  user2_id: string;
  status: MatchStatus;
  expires_at: Date;
  purge_after: Date | null;
  continuation_initiator_id: string | null;
  created_at: Date;
  last_message_at: Date | null;
};

export type CursorMatchRow = MatchRow & { cursor_at: string };

export type UserMatchRow = CursorMatchRow & {
  other_user_id: string;
  other_firstname: string;
  other_age: number;
  other_sex: string | null;
  other_bio: string | null;
  other_photo: string | null;
  other_traits: string[];
  other_profile_answers?: ProfileAnswer[] | null;
  my_revealed: boolean;
  photos_revealed: boolean;
  my_continued: boolean;
  unread_count: number;
  last_message_id: string | null;
  last_message_sender_id: string | null;
  last_message_content: string | null;
  last_message_created_at: Date | null;
  last_message_read_at: Date | null;
};

export type MatchState = { match_id: string; user_id: string; revealed: boolean; continued: boolean };

export type MessageRow = {
  id: string;
  match_id: string;
  sender_id: string;
  content: string;
  created_at: Date;
  read_at: Date | null;
};

export type MessageCreation = {
  message: MessageRow;
  participant_ids: [string, string];
  created: boolean;
};

export type MessageRead = {
  updated_count: number;
  participant_ids: [string, string];
  read_through_message_id: string;
};

export type MessageCreationResult = MatchCommandResult<MessageCreation>
  | { ok: false; reason: 'idempotency_conflict' };

export type CursorMessageRow = MessageRow & { cursor_at: string };

export type MaintenanceResult = { opened: number; expired: number; purged: number };
export type EffectivePlan = { plan: string; weeklyLimit: number | null };
export type MatchAvailabilityFailure = 'not_found' | 'invalid_state' | 'expired';
export type MatchCommandResult<T> = { ok: true; value: T } | { ok: false; reason: MatchAvailabilityFailure };
export type ContinuationResult = 'pending' | 'confirmed' | 'already_recorded' | 'not_available_yet'
  | 'not_found' | 'invalid_state' | 'expired' | 'quota_reached';
