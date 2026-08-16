import { AuthService } from '../../../src/auth/auth.service';

describe('AuthService development registration', () => {
  it('always creates a regular user and never accepts a caller-selected role', async () => {
    const account = { user_id: 'c88624dd-3bd1-43d8-9991-7e6211b3f0e5', role: 'user' as const, is_banned: false };
    const repository = {
      createAccount: jest.fn().mockResolvedValue(account),
      insertRefreshToken: jest.fn().mockResolvedValue(undefined),
    };
    const otp = { normalizePhone: jest.fn().mockReturnValue('+33612345678') };
    const tokens = {
      newRefreshToken: jest.fn().mockReturnValue({
        id: 'ddbf4614-e837-44be-8c88-cffefbc42349', jti: '1790d719-89df-44cc-b184-b7d61d9cb3f7', plain: 'refresh-token',
        hash: 'hash', createdAt: new Date('2030-01-01T00:00:00Z'), expiresAt: new Date('2030-02-01T00:00:00Z'),
      }),
      accessToken: jest.fn().mockResolvedValue('access-token'),
    };
    const service = new AuthService(
      { env: 'development', phone: { encryptionKey: 'k'.repeat(32), hashKey: 'h'.repeat(32) } } as never,
      repository as never,
      otp as never,
      tokens as never,
    );

    await expect(service.register('+33612345678')).resolves.toEqual({
      user_id: account.user_id, access_token: 'access-token', refresh_token: 'refresh-token',
    });
    expect(repository.createAccount).toHaveBeenCalledWith(expect.objectContaining({ role: 'user' }));
    expect(otp.normalizePhone).toHaveBeenCalledWith('+33612345678', 'invalid_registration_request', 'The account creation request is invalid.');
  });

  it('creates at most one superadmin through the development bootstrap with its secret', async () => {
    const account = { user_id: 'c88624dd-3bd1-43d8-9991-7e6211b3f0e5', role: 'superadmin' as const, is_banned: false };
    const repository = {
      createDevelopmentSuperadmin: jest.fn().mockResolvedValue(account),
      insertRefreshToken: jest.fn().mockResolvedValue(undefined),
    };
    const otp = { normalizePhone: jest.fn().mockReturnValue('+33612345678') };
    const tokens = {
      newRefreshToken: jest.fn().mockReturnValue({
        id: 'ddbf4614-e837-44be-8c88-cffefbc42349', jti: '1790d719-89df-44cc-b184-b7d61d9cb3f7', plain: 'refresh-token',
        hash: 'hash', createdAt: new Date('2030-01-01T00:00:00Z'), expiresAt: new Date('2030-02-01T00:00:00Z'),
      }),
      accessToken: jest.fn().mockResolvedValue('access-token'),
    };
    const service = new AuthService(
      { env: 'development', devBootstrapSecret: 'development-secret', phone: { encryptionKey: 'k'.repeat(32), hashKey: 'h'.repeat(32) } } as never,
      repository as never,
      otp as never,
      tokens as never,
    );

    await expect(service.bootstrapSuperadmin('+33612345678', 'wrong-secret')).rejects.toEqual(expect.objectContaining({ code: 'dev_bootstrap_forbidden' }));
    await expect(service.bootstrapSuperadmin('+33612345678', 'development-secret')).resolves.toEqual({
      user_id: account.user_id, access_token: 'access-token', refresh_token: 'refresh-token',
    });
    expect(repository.createDevelopmentSuperadmin).toHaveBeenCalledTimes(1);
  });
});
