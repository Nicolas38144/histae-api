export const OUTBOX_EVENT_TYPES = ['photo.delete', 'notification.push', 'account.erase'] as const;
export type OutboxEventType = typeof OUTBOX_EVENT_TYPES[number];
export type OutboxStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'dead_letter'
  | 'discarded';

export type OutboxEvent = {
  id: string;
  eventType: OutboxEventType;
  aggregateId: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
};

export type NewOutboxEvent = {
  eventType: OutboxEventType;
  aggregateId: string;
  payload?: Record<string, unknown>;
};

export type OutboxRetryResult = 'pending' | 'dead_letter' | 'not_owned';

export type OutboxWorkerResult = {
  claimed: number;
  completed: number;
  deferred: number;
  retried: number;
  deadLettered: number;
  purged: number;
};

export type DeadLetterRow = {
  id: string;
  event_type: OutboxEventType;
  attempts: number;
  last_error_code: string | null;
  created_at: Date;
  dead_lettered_at: Date;
};

export type DeadLetter = Omit<DeadLetterRow, 'id'> & { event_id: string };

export type OutboxOperator = {
  userId: string;
  role: 'admin' | 'superadmin';
};

export type OutboxOperatorResult = 'updated' | 'not_found' | 'not_dead_letter' | 'discard_not_allowed';

export type OutboxStatusSnapshot = {
  pending: number;
  processing: number;
  dead_letter: number;
  discarded: number;
  oldest_pending_at: Date | null;
  notification_push: {
    pending: number;
    processing: number;
    completed: number;
    dead_letter: number;
    discarded: number;
    oldest_pending_at: string | null;
  };
};
