export const OUTBOX_EVENT_TYPES = ['photo.delete'] as const;
export type OutboxEventType = typeof OUTBOX_EVENT_TYPES[number];
export type OutboxStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'dead_letter';

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
  retried: number;
  deadLettered: number;
  purged: number;
};
