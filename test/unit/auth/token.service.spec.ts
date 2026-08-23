import { TokenService } from '../../../src/auth/token.service';

describe('TokenService', () => {
  const jwt = { signAsync: jest.fn().mockResolvedValue('access-token') };
  const config = { jwt: { accessTtlMs: 15 * 60 * 1_000, refreshTtlMs: 60 * 60 * 1_000 } };
  const service = new TokenService(config as never, jwt as never);

  it('creates a rotatable refresh token whose stored representation does not contain the secret', () => {
    const token = service.newRefreshToken();
    const parsed = service.parseRefreshToken(token.plain);

    expect(parsed).toEqual({ jti: token.jti, hash: token.hash });
    expect(token.plain.split(':')[1]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token.hash).not.toContain(token.plain.split(':')[1]);
    expect(service.isUsable({ ...token, user_id: 'user-id', token_hash: token.hash, revoked: false, expires_at: token.expiresAt }, token.hash)).toBe(true);
  });

  it('pins HS256 when issuing access tokens', async () => {
    await expect(service.accessToken('15fc0373-8ed3-4cd6-8b61-3639b84ad966')).resolves.toBe('access-token');
    expect(jwt.signAsync).toHaveBeenCalledWith(
      { sub: '15fc0373-8ed3-4cd6-8b61-3639b84ad966', typ: 'access' },
      expect.objectContaining({ algorithm: 'HS256', audience: 'histae-app', issuer: 'histae-api' }),
    );
  });
});
