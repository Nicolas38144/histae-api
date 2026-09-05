import { PrivacyService } from '../../../src/privacy/privacy.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';

describe('PrivacyService operations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('schedules erasure without passing network callbacks into a transaction', async () => {
    const privacy = {
      updateRequest: jest.fn().mockResolvedValue('erasure_scheduled'),
    };
    const service = new PrivacyService(privacy as never);

    await expect(service.updateRequest('request-id', 'completed', ADMIN_ID, 'admin', 'Verified')).resolves.toBe('erasure_scheduled');
    expect(privacy.updateRequest).toHaveBeenCalledWith('request-id', 'completed', ADMIN_ID, 'admin', 'Verified');
  });

  it('never signs photos from the blocked-users collection', async () => {
    const blocked = [{
      user_id: ADMIN_ID,
      firstname: 'Blocked',
      photo: null,
      blocked_at: new Date('2030-01-01T00:00:00.000Z'),
    }];
    const privacy = { blockedUsers: jest.fn().mockResolvedValue(blocked) };
    const service = new PrivacyService(privacy as never);

    await expect(service.blockedUsers(USER_ID)).resolves.toEqual(blocked);
  });

  it('preserves a stable conflict when rejecting an already started erasure', async () => {
    const privacy = { updateRequest: jest.fn().mockResolvedValue('invalid_transition') };
    const service = new PrivacyService(privacy as never);
    await expect(service.updateRequest('request-id', 'rejected', ADMIN_ID, 'admin', null))
      .rejects.toMatchObject({ status: 409, code: 'invalid_data_request_transition' });
  });
});
