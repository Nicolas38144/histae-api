export const OTP_DELIVERY_STATES = ['pending', 'accepted', 'sent', 'failed', 'unknown'] as const;
export type OtpDeliveryState = typeof OTP_DELIVERY_STATES[number];
export type OtpDeliveryStart = { state: 'created' | OtpDeliveryState; id: string } | { state: 'conflict' };
export type SmsFailureReason = 'not_configured' | 'provider_rejected' | 'provider_unavailable'
  | 'provider_network_error' | 'provider_invalid_response' | 'delivery_unknown' | 'provider_undelivered';

/** Only authenticated, supported provider fields cross the webhook boundary. */
export type SmsDeliveryEvent = {
  deliveryId: string;
  messageId: string;
  transactionId?: string;
  type: 'sms_sent' | 'sms_undelivered';
};

export type OtpDeliverySnapshot = {
  states: Record<OtpDeliveryState, number>;
  awaiting_callback: number;
  oldest_unresolved_age_seconds: number | null;
  average_acceptance_ms: number | null;
  average_sent_callback_ms: number | null;
  average_failure_ms: number | null;
  retention: 'otp_expiry';
  handset_delivery: 'not_confirmed';
};
