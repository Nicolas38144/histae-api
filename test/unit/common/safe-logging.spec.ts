import {
  formatErrorEvent,
  formatLogEvent,
  safeErrorCode,
} from '../../../src/common/logging/safe-logging';

describe('safe operational logging', () => {
  it('formats a bounded event with explicitly safe technical fields', () => {
    expect(formatLogEvent('http_request_failed', {
      method: 'GET',
      route: '/api/users/:id',
      status: 503,
      request_id: '123e4567-e89b-42d3-a456-426614174000',
      duration_ms: 12.4,
    })).toBe(
      'http_request_failed method=GET route=/api/users/:id status=503 '
      + 'request_id=123e4567-e89b-42d3-a456-426614174000 duration_ms=12.4',
    );
  });

  it('never derives a diagnostic from the exception message, stack or cause', () => {
    const error = new Error('Bearer private-token +33600000000', {
      cause: new Error('https://storage.invalid/photo.webp?signature=private'),
    });
    error.stack = 'private stack with webhook payload';

    expect(safeErrorCode(error)).toBe('operation_failed');
    expect(formatErrorEvent('dependency_failed', error)).toBe(
      'dependency_failed error_code=operation_failed',
    );
  });

  it('keeps only explicit or typed normalized error codes', () => {
    expect(safeErrorCode({ code: 'ECONNREFUSED', message: 'private' })).toBe('econnrefused');
    expect(safeErrorCode({ reason: 'provider_timeout', payload: 'private' })).toBe('provider_timeout');
    expect(safeErrorCode(new TypeError('private'))).toBe('type');
    expect(safeErrorCode({ code: 'unsafe code private' })).toBe('operation_failed');
    expect(safeErrorCode({}, 'unsafe fallback private')).toBe('operation_failed');
  });

  it.each([
    ['phone_number', '+33600000000'],
    ['push_token', 'private'],
    ['object_key', 'profile-photos/private.webp'],
    ['review_reason', 'private'],
  ])('rejects the sensitive field %s', (field, value) => {
    expect(() => formatLogEvent('unsafe_attempt', { [field]: value })).toThrow('unsafe_log_field');
  });

  it.each([
    'https://storage.invalid/photo.webp?signature=private',
    'Bearer-private-token=secret',
    'line-one\nline-two',
    'free form provider response',
  ])('rejects an unsafe string value', (value) => {
    expect(() => formatLogEvent('unsafe_attempt', { operation: value })).toThrow('unsafe_log_value');
  });
});
