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

export type MatchState = { match_id: string; user_id: string; revealed: boolean; continued: boolean };

export type MessageRow = {
  id: string;
  match_id: string;
  sender_id: string;
  content: string;
  created_at: Date;
  read_at: Date | null;
};

export type CursorMessageRow = MessageRow & { cursor_at: string };

export type MaintenanceResult = { opened: number; expired: number; purged: number };
export type EffectivePlan = { plan: string; weeklyLimit: number | null };
export type MatchAvailabilityFailure = 'not_found' | 'invalid_state' | 'expired';
export type MatchCommandResult<T> = { ok: true; value: T } | { ok: false; reason: MatchAvailabilityFailure };
export type ContinuationResult = 'pending' | 'confirmed' | 'already_recorded' | 'not_available_yet'
  | 'not_found' | 'invalid_state' | 'expired' | 'quota_reached';
