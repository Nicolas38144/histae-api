import { AuthService } from '../../../src/auth/auth.service';
import { TokenService } from '../../../src/auth/token.service';

const owner = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';

describe('AuthService mobile sessions', () => {
  const config = { jwt: { refreshTtlMs: 3_600_000, accessTtlMs: 900_000 } };
  const tokens = new TokenService(config as never, { signAsync: async () => 'signed-access' } as never);
  const token = tokens.newRefreshToken();

  it('lets the transaction inspect authentic old tokens instead of short-circuiting replay detection', async () => {
    const sessions = { rotate: jest.fn().mockResolvedValue(undefined) };
    const service = new AuthService(config as never, {} as never, {} as never, tokens, sessions as never);
    await expect(service.refresh(token.plain)).rejects.toMatchObject({ status: 401, code: 'invalid_or_expired_refresh_token' });
    expect(sessions.rotate).toHaveBeenCalledWith(token.jti, token.hash, expect.objectContaining({ hash: expect.any(String) }));
  });

  it('rejects malformed refresh tokens before any database access', async () => {
    const sessions = { rotate: jest.fn() };
    const service = new AuthService(config as never, {} as never, {} as never, tokens, sessions as never);
    await expect(service.refresh('invalid')).rejects.toMatchObject({ status: 401 });
    expect(sessions.rotate).not.toHaveBeenCalled();
  });

  it('signs the access token for the family returned by a successful rotation', async () => {
    const accessToken = jest.spyOn(tokens, 'accessToken').mockResolvedValueOnce('signed-access');
    const sessions = { rotate: jest.fn().mockResolvedValue({ userId: owner, sessionId }) };
    const service = new AuthService(config as never, {} as never, {} as never, tokens, sessions as never);
    await expect(service.refresh(token.plain)).resolves.toEqual({ access_token: 'signed-access', refresh_token: expect.any(String) });
    expect(accessToken).toHaveBeenCalledWith(owner, sessionId);
    accessToken.mockRestore();
  });

  it('exposes only the public paginated session fields', async () => {
    const row = { id: sessionId, created_at: new Date(), last_refreshed_at: new Date(), expires_at: new Date(), cursor_at: new Date().toISOString(), token_hash: 'private' };
    const sessions = { list: jest.fn().mockResolvedValue([row]) };
    const service = new AuthService(config as never, {} as never, {} as never, tokens, sessions as never);
    const result = await service.listSessions(owner, sessionId, 20);
    expect(result.sessions[0]).toEqual({ id: sessionId, current: true, created_at: row.created_at, last_refreshed_at: row.last_refreshed_at, expires_at: row.expires_at });
    expect(sessions.list).toHaveBeenCalledWith(owner, 21, undefined);
  });

  it('scopes logout to the bearer session and maps a foreign session to not found', async () => {
    const sessions = { logout: jest.fn().mockResolvedValue(true), revoke: jest.fn().mockResolvedValue(0) };
    const service = new AuthService(config as never, {} as never, {} as never, tokens, sessions as never);
    await service.logout(owner, sessionId, token.plain);
    expect(sessions.logout).toHaveBeenCalledWith(owner, sessionId, token.jti, token.hash, undefined);
    await expect(service.revokeSession(owner, sessionId, owner)).rejects.toMatchObject({ status: 404, code: 'session_not_found' });
  });
});
