export const DEVICE_PLATFORMS = ['ios', 'android'] as const;
export type DevicePlatform = typeof DEVICE_PLATFORMS[number];

export type DeviceRow = {
  id: string;
  user_id: string;
  token: string;
  platform: DevicePlatform;
  app_version: string | null;
  created_at: Date;
  last_used_at: Date | null;
};

export const MOBILE_EVENT_TYPES = [
  'match.created',
  'match.updated',
  'matches.invalidated',
  'message.created',
  'message.read',
  'subscription.updated',
] as const;
export type MobileEventType = typeof MOBILE_EVENT_TYPES[number];

export type MobileEvent = {
  id: string;
  user_id: string;
  type: MobileEventType;
  occurred_at: string;
  data: Record<string, string | number | boolean | null>;
};

export type NotificationType = 'new_match' | 'new_message' | 'billing_payment_failed' | 'subscription_trial_ending';
