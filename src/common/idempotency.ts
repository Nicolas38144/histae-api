import { apiError } from './api-error';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function normalizeIdempotencyKey(input: string | undefined): string {
  const key = input?.trim().toLowerCase() ?? '';
  if (!UUID_V4.test(key)) {
    throw apiError(400, 'invalid_idempotency_key', 'The Idempotency-Key header must contain a UUID v4.');
  }
  return key;
}
