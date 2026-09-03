import { MobileService } from '../../../src/mobile/mobile.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';

describe('MobileService', () => {
  const storedDevice = {
    id: DEVICE_ID,
    user_id: USER_ID,
    session_id: USER_ID,
    token: 'provider-secret-token-that-must-not-leak',
    platform: 'android' as const,
    app_version: '1.2.3',
    created_at: new Date('2030-01-01T00:00:00.000Z'),
    last_used_at: new Date('2030-01-02T00:00:00.000Z'),
  };

  it('registers a trimmed push token without exposing it in the response', async () => {
    const repository = { registerDevice: jest.fn().mockResolvedValue(storedDevice) };
    const service = new MobileService(repository as never);

    await expect(service.registerDevice(USER_ID, USER_ID, `  ${storedDevice.token}  `, 'android', ' 1.2.3 ')).resolves.toEqual({
      id: DEVICE_ID,
      session_id: USER_ID,
      platform: 'android',
      app_version: '1.2.3',
      created_at: storedDevice.created_at,
      last_used_at: storedDevice.last_used_at,
    });
    expect(repository.registerDevice).toHaveBeenCalledWith(USER_ID, USER_ID, storedDevice.token, 'android', '1.2.3');
  });

  it('returns a stable not-found error for an unknown device owned by the user', async () => {
    const repository = { removeDevice: jest.fn().mockResolvedValue(false) };
    const service = new MobileService(repository as never);

    await expect(service.removeDevice(USER_ID, DEVICE_ID)).rejects.toEqual(expect.objectContaining({
      status: 404,
      code: 'device_not_found',
    }));
  });
});
