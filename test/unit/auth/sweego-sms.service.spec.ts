import { SweegoSmsService } from '../../../src/auth/sweego-sms.service';

describe('SweegoSmsService', () => {
  const originalFetch = global.fetch;
  const config = {
    sms: {
      provider: 'sweego',
      endpoint: 'https://api.sweego.io/send',
      apiKey: 'secret-api-key',
      senderId: 'Histae',
      timeoutMillis: 10_000,
      otpTtlMillis: 600_000,
    },
  };

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('uses the official transactional SMS contract without exposing the API key in the body', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      status: 200,
      json: jest.fn().mockResolvedValue({
        transaction_id: 'transaction-1',
        swg_uids: { '+33612345678': 'message-1' },
      }),
    });
    global.fetch = fetchMock as never;
    const service = new SweegoSmsService(config as never);

    await expect(service.sendOtp({
      phone: '+33612345678',
      region: 'FR',
      code: '123456',
      deliveryId: 'f5c3c744-a75f-46e7-8b59-6b94671cb029',
    })).resolves.toEqual({ transactionId: 'transaction-1', messageId: 'message-1' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(url).toBe('https://api.sweego.io/send');
    expect(init.headers).toEqual({ 'Api-Key': 'secret-api-key', 'Content-Type': 'application/json' });
    expect(body).toEqual(expect.objectContaining({
      channel: 'sms',
      provider: 'sweego',
      'campaign-type': 'transac',
      'campaign-id': 'f5c3c744-a75f-46e7-8b59-6b94671cb029',
      'sender-id': 'Histae',
      recipients: [{ num: '+33612345678', region: 'FR' }],
      'message-txt': expect.stringContaining('123456'),
    }));
    expect(JSON.stringify(body)).not.toContain('secret-api-key');
  });

  it('maps non-200 and malformed responses without returning provider bodies', async () => {
    const service = new SweegoSmsService(config as never);
    const cancel = jest.fn().mockResolvedValue(undefined);
    global.fetch = jest.fn().mockResolvedValue({ status: 429, body: { cancel } }) as never;
    await expect(service.sendOtp({
      phone: '+33612345678', region: 'FR', code: '123456', deliveryId: 'delivery-1',
    })).rejects.toEqual(expect.objectContaining({ reason: 'provider_http_429' }));
    expect(cancel).toHaveBeenCalledTimes(1);

    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      json: jest.fn().mockResolvedValue({ transaction_id: 'transaction-1', swg_uids: {} }),
    }) as never;
    await expect(service.sendOtp({
      phone: '+33612345678', region: 'FR', code: '123456', deliveryId: 'delivery-2',
    })).rejects.toEqual(expect.objectContaining({ reason: 'provider_invalid_response' }));

    global.fetch = jest.fn().mockResolvedValue({
      status: 200,
      json: jest.fn().mockResolvedValue({ transaction_id: 'transaction-1', swg_uids: ['message-1'] }),
    }) as never;
    await expect(service.sendOtp({
      phone: '+33612345678', region: 'FR', code: '123456', deliveryId: 'delivery-3',
    })).rejects.toEqual(expect.objectContaining({ reason: 'provider_invalid_response' }));
  });

  it('fails closed when SMS delivery is disabled', async () => {
    const service = new SweegoSmsService({ sms: { ...config.sms, provider: 'disabled' } } as never);
    await expect(service.sendOtp({
      phone: '+33612345678', region: 'FR', code: '123456', deliveryId: 'delivery-1',
    })).rejects.toEqual(expect.objectContaining({ reason: 'not_configured' }));
  });
});
