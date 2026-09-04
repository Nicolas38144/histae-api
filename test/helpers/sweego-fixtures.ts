import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { SweegoWebhookHeaders } from '../../src/auth/sweego-webhook.signature';

export const sweegoSecret = randomBytes(48).toString('base64');
export function smsEvent<T extends Record<string, unknown> = Record<never, never>>(overrides: T = {} as T) {
  return { event_type: 'sms_sent', timestamp: '2026-09-04T12:00:00', swg_uid: `03-${randomUUID()}`,
    event_id: randomUUID(), channel: 'sms', campaign_id: randomUUID(), sender_id: 'Histae', test_mode: false,
    ...overrides };
}
export function signSmsBody(body: Buffer, secret = sweegoSecret, timestamp = String(Math.floor(Date.now() / 1_000))): SweegoWebhookHeaders {
  const id = randomUUID();
  return { id, timestamp, signature: createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(`${id}.${timestamp}.`).update(body).digest('base64') };
}
