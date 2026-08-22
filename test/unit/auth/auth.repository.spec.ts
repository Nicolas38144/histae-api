import { AuthRepository } from '../../../src/auth/auth.repository';

describe('AuthRepository logout', () => {
  it('revokes the refresh token and removes the selected device in one transaction', async () => {
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 }) };
    const database = {
      transaction: jest.fn(async (work: (transactionClient: typeof client) => Promise<boolean>) => work(client)),
    };
    const repository = new AuthRepository(database as never);

    await expect(repository.revokeRefreshToken('user-id', 'jti', 'hash', 'device-id')).resolves.toBe(true);

    expect(client.query).toHaveBeenNthCalledWith(2,
      'DELETE FROM device_token WHERE id = $1 AND user_id = $2',
      ['device-id', 'user-id'],
    );
  });

  it('does not remove a device when refresh-token revocation fails', async () => {
    const client = { query: jest.fn().mockResolvedValueOnce({ rowCount: 0 }) };
    const database = {
      transaction: jest.fn(async (work: (transactionClient: typeof client) => Promise<boolean>) => work(client)),
    };
    const repository = new AuthRepository(database as never);

    await expect(repository.revokeRefreshToken('user-id', 'jti', 'hash', 'device-id')).resolves.toBe(false);
    expect(client.query).toHaveBeenCalledTimes(1);
  });
});
