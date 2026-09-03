import { generateKeyPairSync } from 'node:crypto';
import { PushDeliveryError, PushService } from '../../../src/mobile/push.service';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const enabled = { push: {
  provider: 'fcm', projectId: 'test-project', clientEmail: 'test@example.invalid', privateKey,
  tokenUri: 'https://oauth2.googleapis.com/token', timeoutMillis: 500,
} };

describe('PushService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends metadata with a bounded request and uses the cached OAuth token', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValueOnce(response(200, { access_token: 'test-access', expires_in: 3600 }))
      .mockResolvedValue(response(200, {}));
    const service = new PushService(enabled as never, {} as never);
    await service.sendToDevice('test-device', 'new_message', { notification_id: 'stable-id' });
    await service.sendToDevice('test-device', 'new_message', { notification_id: 'stable-id' });
    expect(fetch).toHaveBeenCalledTimes(3);
    const request = fetch.mock.calls[1]![1]!;
    expect(JSON.parse(request.body as string).message.data).toEqual({ type: 'new_message', notification_id: 'stable-id' });
    expect(request.signal).toBeDefined();
  });

  it.each([429, 500, 503, 404])('propagates HTTP %s without deleting a valid device or retaining provider details', async (status) => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(response(200, { access_token: 'test-access' }))
      .mockResolvedValueOnce(response(status, { error: { status: 'NOT_FOUND', message: 'sensitive provider detail' } }));
    const repository = { removeToken: jest.fn() };
    await expect(new PushService(enabled as never, repository as never).sendToDevice('test-device', 'billing_payment_failed', {}))
      .rejects.toEqual(new PushDeliveryError());
    expect(repository.removeToken).not.toHaveBeenCalled();
  });

  it('removes only an explicitly unregistered token and treats that delivery as terminal', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(response(200, { access_token: 'test-access' }))
      .mockResolvedValueOnce(response(404, { error: { details: [{ errorCode: 'UNREGISTERED' }] } }));
    const repository = { removeToken: jest.fn().mockResolvedValue(undefined) };
    await expect(new PushService(enabled as never, repository as never).sendToDevice('test-device', 'new_match', {})).resolves.toBeUndefined();
    expect(repository.removeToken).toHaveBeenCalledWith('test-device');
  });

  it('retries OAuth after an unauthorized send and sanitizes network failures', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValueOnce(response(200, { access_token: 'test-access' }))
      .mockResolvedValueOnce(response(401, {}))
      .mockRejectedValueOnce(new Error('token=confidential'));
    const service = new PushService(enabled as never, {} as never);
    await expect(service.sendToDevice('test-device', 'new_match', {})).rejects.toEqual(new PushDeliveryError());
    await expect(service.sendToDevice('test-device', 'new_match', {})).rejects.toEqual(new PushDeliveryError());
    expect(fetch.mock.calls[2]![0]).toBe(enabled.push.tokenUri);
  });
  it('does not load device tokens or call the network when push delivery is disabled', async () => {
    const repository = { tokensForUser: jest.fn() };
    const service = new PushService({ push: { provider: 'disabled' } } as never, repository as never);
    const fetchSpy = jest.spyOn(global, 'fetch');

    await expect(service.sendToDevice('device-token', 'new_message', { match_id: 'match-id' })).resolves.toBeUndefined();

    expect(repository.tokensForUser).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

function response(status: number, body: object): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
