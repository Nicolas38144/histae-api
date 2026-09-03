import { jwtKeys } from '../../../src/config/jwt-keys';

describe('JWT signing key ring', () => {
  const current = 'test-current-signing-key-of-32-bytes-minimum';
  const previous = 'test-previous-signing-key-of-32-bytes-minimum';
  it('accepts a bounded local set of verification keys', () => {
    expect([...jwtKeys('current', current, JSON.stringify({ previous }))]).toEqual([['current', current], ['previous', previous]]);
  });
  it.each(['not-json', 'null', '[]', '{"old":42}', '{"old":"short"}', '{"../../key":"long-enough-but-not-a-valid-key-id"}'])('rejects invalid key-ring configuration without echoing it', (value) => {
    expect(() => jwtKeys('current', current, value)).toThrow('config: JWT_ACTIVE_KID and JWT_PREVIOUS_KEYS');
  });
  it('rejects duplicate active IDs, duplicate key material and excessive rings', () => {
    expect(() => jwtKeys('current', current, JSON.stringify({ current: previous }))).toThrow();
    expect(() => jwtKeys('current', current, JSON.stringify({ old: current }))).toThrow();
    expect(() => jwtKeys('invalid/path', current, '{}')).toThrow();
    expect(() => jwtKeys('current', current, JSON.stringify(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`key${i}`, `${previous}${i}`]))))).toThrow();
  });
});
