import type { Sex } from '../users/users.models';

export const SWIPE_DECISIONS = ['like', 'pass'] as const;
export type SwipeDecision = typeof SWIPE_DECISIONS[number];

export type DiscoveryCandidateRow = {
  user_id: string;
  firstname: string;
  age: number;
  sex: Sex;
  bio: string | null;
  distance_km: number;
  traits: string[];
};

export type DiscoveryCursor = { distance_km: number; id: string };

export type DiscoveryAction = {
  actor_id: string;
  target_id: string;
  decision: SwipeDecision;
  swiped_at: Date;
};

export type DiscoveryDataReferences = {
  outgoing: DiscoveryAction[];
  incoming: DiscoveryAction[];
};

export type FeedCandidate = Omit<DiscoveryCandidateRow, 'distance_km'> & { distance_km: number };
