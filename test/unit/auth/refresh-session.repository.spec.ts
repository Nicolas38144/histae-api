import { RefreshSessionRepository } from '../../../src/auth/refresh-session.repository';

describe('RefreshSessionRepository logout', () => {
  it('revokes the refresh token and removes the selected device in one transaction', async () => {
    const token = { id: 'token-id', user_id: 'user-id', family_id: 'session-id', token_hash: 'hash' };
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [token] })
      .mockResolvedValueOnce({ rows: [{ user_id: 'user-id' }] })
      .mockResolvedValueOnce({ rows: [token] })
      .mockResolvedValueOnce({ rows: [{ id: 'session-id' }] })
      .mockResolvedValue({ rowCount: 1 }) };
    const database = {
      transaction: jest.fn(async (work: (transactionClient: typeof client) => Promise<boolean>) => work(client)),
    };
    const repository = new RefreshSessionRepository(database as never);

    await expect(repository.logout('user-id', 'session-id', 'jti', 'hash', 'device-id')).resolves.toBe(true);

    expect(client.query).toHaveBeenLastCalledWith(
      'DELETE FROM device_token WHERE id = $1 AND user_id = $2',
      ['device-id', 'user-id'],
    );
  });

  it('does not remove a device when refresh-token revocation fails', async () => {
    const client = { query: jest.fn().mockResolvedValueOnce({ rows: [] }) };
    const database = {
      transaction: jest.fn(async (work: (transactionClient: typeof client) => Promise<boolean>) => work(client)),
    };
    const repository = new RefreshSessionRepository(database as never);

    await expect(repository.logout('user-id', 'session-id', 'jti', 'hash', 'device-id')).resolves.toBe(false);
    expect(client.query).toHaveBeenCalledTimes(1);
  });
});
