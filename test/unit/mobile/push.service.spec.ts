import { PushService } from '../../../src/mobile/push.service';

describe('PushService', () => {
  it('does not load device tokens or call the network when push delivery is disabled', async () => {
    const repository = { tokensForUser: jest.fn() };
    const service = new PushService({ push: { provider: 'disabled' } } as never, repository as never);
    const fetchSpy = jest.spyOn(global, 'fetch');

    await expect(service.sendToUser('user-id', 'new_message', { match_id: 'match-id' })).resolves.toBeUndefined();

    expect(repository.tokensForUser).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
