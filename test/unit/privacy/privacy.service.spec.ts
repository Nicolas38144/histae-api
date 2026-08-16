import { PrivacyService } from '../../../src/privacy/privacy.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';

describe('PrivacyService cross-database privacy operations', () => {
  it('exports only the user own Scylla actions and never other users decisions', async () => {
    const privacy = { exportUserData: jest.fn().mockResolvedValue({ profile: { firstname: 'Ada' } }) };
    const actions = [{ actor_id: USER_ID, target_id: ADMIN_ID, decision: 'like' }];
    const discovery = { exportOwnActions: jest.fn().mockResolvedValue(actions) };
    const service = new PrivacyService(privacy as never, discovery as never);

    await expect(service.exportUserData(USER_ID)).resolves.toEqual({
      profile: { firstname: 'Ada' },
      discovery_actions: { outgoing: actions },
    });
    expect(discovery.exportOwnActions).toHaveBeenCalledWith(USER_ID);
  });

  it('provides the Scylla erasure step when an erasure request is completed', async () => {
    const discovery = { deleteUserData: jest.fn().mockResolvedValue(undefined) };
    const privacy = {
      updateRequest: jest.fn(async (...args: unknown[]) => {
        const beforeErasure = args[5] as (userId: string) => Promise<void>;
        await beforeErasure(USER_ID);
        return 'updated';
      }),
    };
    const service = new PrivacyService(privacy as never, discovery as never);

    await service.updateRequest('request-id', 'completed', ADMIN_ID, 'admin', 'Verified');

    expect(discovery.deleteUserData).toHaveBeenCalledWith(USER_ID);
  });
});
