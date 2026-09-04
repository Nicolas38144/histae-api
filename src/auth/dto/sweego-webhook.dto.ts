import { isUUID } from 'class-validator';
import { apiError } from '../../common/api-error';
import type { SmsDeliveryEvent } from '../otp-delivery.models';
import { smsProviderIdentifier } from '../sms-delivery';

const STRING_FIELDS = new Set(['timestamp', 'swg_uid', 'event_id', 'details', 'channel', 'client-id', 'client_id',
  'country_code', 'phone_number', 'sender_id', 'sms_type', 'campaign_id', 'transaction_id', 'send_date', 'status']);
const NUMBER_FIELDS = new Set(['sms_price', 'nb_segments', 'mobile_network_code', 'mobile_country_code']);

/** Provider DTO: allow documented metadata, then immediately discard it. Never persist the raw body. */
export function sweegoDeliveryEvent(value: unknown, senderId: string): SmsDeliveryEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidEvent();
  const data = value as Record<string, unknown>;
  if (typeof data.event_type !== 'string' || !/^[a-z_]{1,64}$/.test(data.event_type)) throw invalidEvent();
  // A valid signature on another event does not authorize an OTP transition.
  if (data.event_type !== 'sms_sent' && data.event_type !== 'sms_undelivered') return null;
  for (const [key, field] of Object.entries(data)) {
    if (key === 'event_type' || key === 'test_mode') continue;
    if (STRING_FIELDS.has(key) && typeof field === 'string' && field.length <= 512) continue;
    if (NUMBER_FIELDS.has(key) && typeof field === 'number' && Number.isFinite(field) && field >= 0) continue;
    throw invalidEvent();
  }
  if (data.channel !== 'sms' || typeof data.test_mode !== 'boolean'
    || typeof data.sender_id !== 'string' || typeof data.timestamp !== 'string'
    || typeof data.event_id !== 'string' || !isUUID(data.event_id)
    || typeof data.campaign_id !== 'string'
    || !smsProviderIdentifier(data.swg_uid)
    || (data.transaction_id !== undefined && !smsProviderIdentifier(data.transaction_id))) throw invalidEvent();
  if (data.test_mode || data.sender_id !== senderId || !isUUID(data.campaign_id, '4')) return null;
  return { type: data.event_type, deliveryId: data.campaign_id.toLowerCase(), messageId: data.swg_uid,
    ...(typeof data.transaction_id === 'string' ? { transactionId: data.transaction_id } : {}) };
}

function invalidEvent() {
  return apiError(400, 'invalid_sweego_event', 'The SMS event is invalid.');
}
