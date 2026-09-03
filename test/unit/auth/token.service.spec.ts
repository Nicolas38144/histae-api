import { TokenService } from '../../../src/auth/token.service';

describe('TokenService', () => {
  const jwt = { signAsync: jest.fn().mockResolvedValue('access-token') };
  const config = { jwt: { activeKid: 'primary', secret: 'test-signing-secret', accessTtlMs: 15 * 60 * 1_000, refreshTtlMs: 60 * 60 * 1_000 } };
  const service = new TokenService(config as never, jwt as never);

  it('creates a rotatable refresh token whose stored representation does not contain the secret', () => {
    const token = service.newRefreshToken();
    const parsed = service.parseRefreshToken(token.plain);

    expect(parsed).toEqual({ jti: token.jti, hash: token.hash });
    expect(token.plain.split(':')[1]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token.hash).not.toContain(token.plain.split(':')[1]);
  });

  it('pins HS256 when issuing access tokens', async () => {
    await expect(service.accessToken('15fc0373-8ed3-4cd6-8b61-3639b84ad966', 'session-id')).resolves.toBe('access-token');
    expect(jwt.signAsync).toHaveBeenCalledWith(
      { sub: '15fc0373-8ed3-4cd6-8b61-3639b84ad966', sid: 'session-id', typ: 'access' },
      expect.objectContaining({ algorithm: 'HS256', keyid: 'primary', secret: config.jwt.secret, audience: 'histae-app', issuer: 'histae-api' }),
    );
  });

  it.each([
    '',
    'not-a-uuid:secret',
    '11111111-1111-1111-8111-111111111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    '11111111-1111-4111-8111-111111111111:too-short',
    '11111111-1111-4111-8111-111111111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!',
  ])('rejects malformed refresh tokens without hashing attacker-controlled shapes (%s)', (token) => {
    expect(service.parseRefreshToken(token)).toBeUndefined();
  });
});
