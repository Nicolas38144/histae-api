const EVENT_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const STRING_VALUE_PATTERN = /^[A-Za-z0-9_./:<>{}*,-]{1,200}$/;
const ALLOWED_FIELDS = new Set([
  'batches',
  'billing_processed',
  'duration_ms',
  'environment',
  'error_code',
  'event_id',
  'event_type',
  'failures',
  'method',
  'matches_processed',
  'operation',
  'photo_failures',
  'photos_cleaned',
  'photos_expired_requests',
  'port',
  'privacy_processed',
  'request_id',
  'route',
  'status',
]);

export type SafeLogValue = string | number | boolean;

/**
 * Formats one-line operational events. Field names deliberately exclude data
 * classes that could contain user, provider or authentication material.
 */
export function formatLogEvent(
  event: string,
  fields: Readonly<Record<string, SafeLogValue>> = {},
): string {
  if (!EVENT_PATTERN.test(event)) throw new Error('invalid_log_event');
  const output = [event];
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(key)) throw new Error('unsafe_log_field');
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('unsafe_log_value');
    }
    if (typeof value === 'string' && !STRING_VALUE_PATTERN.test(value)) {
      throw new Error('unsafe_log_value');
    }
    output.push(`${key}=${String(value)}`);
  }
  return output.join(' ');
}

/** Returns a bounded diagnostic code without reading message, stack or cause. */
export function safeErrorCode(error: unknown, fallback = 'operation_failed'): string {
  const explicit = property(error, 'code') ?? property(error, 'reason');
  return normalizeCode(explicit) ?? normalizeErrorName(error) ?? normalizeCode(fallback) ?? 'operation_failed';
}

export function formatErrorEvent(
  event: string,
  error: unknown,
  fields: Readonly<Record<string, SafeLogValue>> = {},
): string {
  return formatLogEvent(event, { ...fields, error_code: safeErrorCode(error) });
}

function property(value: unknown, name: 'code' | 'reason'): string | undefined {
  if (typeof value !== 'object' || value === null || !(name in value)) return undefined;
  const candidate = (value as Record<string, unknown>)[name];
  return typeof candidate === 'string' ? candidate : undefined;
}

function normalizeErrorName(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name === 'Error') return undefined;
  return normalizeCode(error.name.replace(/Error$/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2'));
}

function normalizeCode(value: string | undefined): string | undefined {
  if (!value || !/^(?:[A-Za-z][A-Za-z0-9_-]{0,63}|[0-9][A-Za-z0-9_-]{0,56})$/.test(value)) return undefined;
  const normalized = value.replace(/-/g, '_').toLowerCase();
  return /^[a-z]/.test(normalized) ? normalized : `error_${normalized}`;
}
