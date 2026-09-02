import type { Sex } from '../users/users.models';
import type { ProfileAnswer } from '../profile-questions/profile-questions.models';

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
  profile_answers?: ProfileAnswer[] | null;
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

export type FeedCandidate = Omit<DiscoveryCandidateRow, 'distance_km' | 'profile_answers'> & {
  distance_km: number;
  profile_answers: ProfileAnswer[];
};

export const DISCOVERY_REQUIRED_ACTIONS = [
  'profile',
  'sex',
  'preferences',
  'sensitive_data_consent',
  'location_consent',
  'fresh_presence',
] as const;
export type DiscoveryRequiredAction = typeof DISCOVERY_REQUIRED_ACTIONS[number];

export type DiscoveryStatusRow = {
  has_profile: boolean;
  has_sex: boolean;
  has_preferences: boolean;
  has_sensitive_consent: boolean;
  has_location_consent: boolean;
  has_fresh_presence: boolean;
  presence_expires_at: Date | null;
};

export type DiscoveryStatus = {
  ready: boolean;
  required_actions: DiscoveryRequiredAction[];
  presence_expires_at: Date | null;
};
