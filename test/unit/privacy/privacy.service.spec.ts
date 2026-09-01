import { PrivacyService } from '../../../src/privacy/privacy.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';

describe('PrivacyService cross-database privacy operations', () => {
  const noOpBilling = { deleteCustomerForAccount: jest.fn().mockResolvedValue(undefined) };
  const noOpPhotos = {
    urlForKey: jest.fn(async (key: string | null) => key),
    deleteForAccount: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('exports only the user own Scylla actions and never other users decisions', async () => {
    const privacy = { exportUserData: jest.fn().mockResolvedValue({ profile: { firstname: 'Ada' } }) };
    const actions = [{ actor_id: USER_ID, target_id: ADMIN_ID, decision: 'like' }];
    const discovery = { exportOwnActions: jest.fn().mockResolvedValue(actions) };
    const service = new PrivacyService(privacy as never, discovery as never, noOpBilling as never, noOpPhotos as never);

    await expect(service.exportUserData(USER_ID)).resolves.toEqual({
      profile: { firstname: 'Ada', photo: null },
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
    const service = new PrivacyService(privacy as never, discovery as never, noOpBilling as never, noOpPhotos as never);

    await service.updateRequest('request-id', 'completed', ADMIN_ID, 'admin', 'Verified');

    expect(discovery.deleteUserData).toHaveBeenCalledWith(USER_ID);
  });

  it('never signs photos from the blocked-users collection', async () => {
    const blocked = [{
      user_id: ADMIN_ID,
      firstname: 'Blocked',
      photo: null,
      blocked_at: new Date('2030-01-01T00:00:00.000Z'),
    }];
    const privacy = { blockedUsers: jest.fn().mockResolvedValue(blocked) };
    const service = new PrivacyService(privacy as never, {} as never, noOpBilling as never, noOpPhotos as never);

    await expect(service.blockedUsers(USER_ID)).resolves.toEqual(blocked);
    expect(noOpPhotos.urlForKey).not.toHaveBeenCalled();
  });

  it('deletes Stripe before Scylla when an administrator completes an erasure request', async () => {
    const calls: string[] = [];
    const discovery = { deleteUserData: jest.fn(async () => { calls.push('scylla'); }) };
    const billing = { deleteCustomerForAccount: jest.fn(async () => { calls.push('stripe'); }) };
    const photos = {
      urlForKey: jest.fn(async (key: string | null) => key),
      deleteForAccount: jest.fn(async () => { calls.push('storage'); }),
    };
    const privacy = {
      updateRequest: jest.fn(async (...args: unknown[]) => {
        const beforeErasure = args[5] as (userId: string) => Promise<void>;
        await beforeErasure(USER_ID);
        return 'updated';
      }),
    };
    const service = new PrivacyService(privacy as never, discovery as never, billing as never, photos as never);

    await service.updateRequest('request-id', 'completed', ADMIN_ID, 'admin', 'Verified');

    expect(calls).toEqual(['stripe', 'storage', 'scylla']);
  });
});
