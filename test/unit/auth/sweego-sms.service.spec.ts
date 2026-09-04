import { SweegoSmsService } from '../../../src/auth/sweego-sms.service';

describe('SweegoSmsService', () => {
  const originalFetch = global.fetch;
  const config = { sms: { provider: 'sweego', endpoint: 'https://api.sweego.io/send', apiKey: 'fixture-api-key',
    senderId: 'Histae', timeoutMillis: 10_000, otpTtlMillis: 600_000 } };
  const message = { phone: '+33600000000', region: 'FR', code: '123456', deliveryId: 'f5c3c744-a75f-46e7-8b59-6b94671cb029' };
  const receipt = { transaction_id: 'transaction-1', swg_uids: { '+33600000000': 'message-1' } };
  afterEach(() => { global.fetch = originalFetch; });

  it('uses the transactional contract, correlation campaign ID and no redirects/retries', async () => {
    const fetchMock = jest.fn().mockResolvedValue(Response.json(receipt));
    global.fetch = fetchMock;
    await expect(new SweegoSmsService(config as never).sendOtp(message))
      .resolves.toEqual({ transactionId: 'transaction-1', messageId: 'message-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(url).toBe('https://api.sweego.io/send');
    expect(init.redirect).toBe('error');
    expect(init.headers).toEqual({ 'Api-Key': 'fixture-api-key', 'Content-Type': 'application/json' });
    expect(body).toMatchObject({ channel: 'sms', provider: 'sweego', 'campaign-type': 'transac',
      'campaign-id': message.deliveryId, 'sender-id': 'Histae', recipients: [{ num: message.phone, region: 'FR' }],
      'message-txt': expect.stringContaining(message.code) });
    expect(JSON.stringify(body)).not.toContain('fixture-api-key');
  });
  it.each([400, 401, 403, 404, 405, 413, 415, 422, 429])('classifies HTTP %d as rejection without retaining the body', async status => {
    global.fetch = jest.fn().mockResolvedValue(new Response('private provider body', { status }));
    const failure = new SweegoSmsService(config as never).sendOtp(message);
    await expect(failure).rejects.toMatchObject({ reason: 'provider_rejected', outcome: 'failed' });
    await expect(failure).rejects.not.toHaveProperty('cause');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([202, 302, 408, 500, 503])('keeps HTTP %d uncertain, never retrying automatically', async status => {
    global.fetch = jest.fn().mockResolvedValue(new Response('private provider body', { status }));
    await expect(new SweegoSmsService(config as never).sendOtp(message))
      .rejects.toMatchObject({ reason: 'provider_unavailable', outcome: 'unknown' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...receipt, swg_uids: {} }, { ...receipt, swg_uids: ['message-1'] },
    { ...receipt, swg_uids: { a: 'one', b: 'two' } }, { ...receipt, transaction_id: 'x'.repeat(129) },
    { ...receipt, swg_uids: { a: 'private data' } },
  ])('treats an invalid receipt as uncertain: %p', async payload => {
    global.fetch = jest.fn().mockResolvedValue(Response.json(payload));
    await expect(new SweegoSmsService(config as never).sendOtp(message))
      .rejects.toMatchObject({ reason: 'provider_invalid_response', outcome: 'unknown' });
  });
  it.each(['invalid-json', 'x'.repeat(16_385)])('bounds invalid response data (%#)', async payload => {
    global.fetch = jest.fn().mockResolvedValue(new Response(payload));
    await expect(new SweegoSmsService(config as never).sendOtp(message))
      .rejects.toMatchObject({ reason: 'provider_invalid_response', outcome: 'unknown' });
  });
  it('normalizes network and response-stream failures without sensitive causes', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('phone private API key'));
    const networkFailure = new SweegoSmsService(config as never).sendOtp(message);
    await expect(networkFailure).rejects.toMatchObject({ reason: 'provider_network_error', outcome: 'unknown' });
    await expect(networkFailure).rejects.not.toHaveProperty('cause');
    const stream = new ReadableStream({ start(controller) { controller.error(new Error('private body')); } });
    global.fetch = jest.fn().mockResolvedValue(new Response(stream));
    const streamFailure = new SweegoSmsService(config as never).sendOtp(message);
    await expect(streamFailure).rejects.toMatchObject({ reason: 'provider_invalid_response', outcome: 'unknown' });
    await expect(streamFailure).rejects.not.toHaveProperty('cause');
  });
  it('fails closed without a network call when disabled', async () => {
    global.fetch = jest.fn();
    await expect(new SweegoSmsService({ sms: { ...config.sms, provider: 'disabled' } } as never).sendOtp(message))
      .rejects.toMatchObject({ reason: 'not_configured', outcome: 'failed' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
