import { createHmac, timingSafeEqual } from 'node:crypto';
import { apiError } from '../common/api-error';
import { MAX_SMS_PROVIDER_BODY_BYTES } from './sms-delivery';

export type SweegoWebhookHeaders = {
  id: string | string[] | undefined;
  timestamp: string | string[] | undefined;
  signature: string | string[] | undefined;
};

/** Sweego signs id.timestamp.rawBody with the base64-decoded dashboard secret. */
export function verifySweegoSignature(body: Buffer | undefined, headers: SweegoWebhookHeaders, secret: string, now = Date.now()): Buffer {
  const { id, timestamp, signature } = headers;
  if (!body || body.length > MAX_SMS_PROVIDER_BODY_BYTES || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)
    || typeof timestamp !== 'string' || !/^[0-9]{1,12}$/.test(timestamp)
    || typeof signature !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(signature)
    || !/^[A-Za-z0-9+/]{64}$/.test(secret)) throw invalidSignature();
  const age = now - Number(timestamp) * 1_000;
  if (age > 300_000 || age < -60_000) throw invalidSignature();
  const supplied = Buffer.from(signature, 'base64');
  const expected = createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(`${id}.${timestamp}.`).update(body).digest();
  if (supplied.toString('base64') !== signature || !timingSafeEqual(supplied, expected)) throw invalidSignature();
  return body;
}

function invalidSignature() {
  return apiError(401, 'invalid_sweego_signature', 'The SMS webhook signature is invalid.');
}
