import { MatchesService } from '../../../src/matches/matches.service';

const MATCH_ID = '11111111-1111-4111-8111-111111111111';
const SENDER_ID = '22222222-2222-4222-8222-222222222222';
const RECIPIENT_ID = '33333333-3333-4333-8333-333333333333';
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
const IDEMPOTENCY_KEY = '55555555-5555-4555-8555-555555555555';

describe('MatchesService mobile messaging', () => {
  const photos = { urlForKey: jest.fn(async (key: string | null) => key) };
  const message = {
    id: MESSAGE_ID,
    match_id: MATCH_ID,
    sender_id: SENDER_ID,
    content: 'Bonjour',
    created_at: new Date('2030-01-01T00:00:00.000Z'),
    read_at: null,
  };

  it('forwards a normalized idempotency key and delivers only newly-created messages', async () => {
    const repository = { createMessage: jest.fn()
      .mockResolvedValueOnce({ ok: true, value: { message, participant_ids: [SENDER_ID, RECIPIENT_ID], created: true } })
      .mockResolvedValueOnce({ ok: true, value: { message, participant_ids: [SENDER_ID, RECIPIENT_ID], created: false } }) };
    const delivery = { messageCreated: jest.fn() };
    const service = new MatchesService(repository as never, photos as never, delivery as never);

    await expect(service.sendMessage(MATCH_ID, SENDER_ID, '  Bonjour  ', IDEMPOTENCY_KEY)).resolves.toEqual(expect.objectContaining({ id: MESSAGE_ID }));
    await expect(service.sendMessage(MATCH_ID, SENDER_ID, 'Bonjour', IDEMPOTENCY_KEY)).resolves.toEqual(expect.objectContaining({ id: MESSAGE_ID }));

    expect(repository.createMessage).toHaveBeenNthCalledWith(1, expect.any(String), MATCH_ID, SENDER_ID, 'Bonjour', IDEMPOTENCY_KEY);
    expect(delivery.messageCreated).toHaveBeenCalledTimes(1);
  });

  it('maps repository idempotency conflicts to the stable public error', async () => {
    const repository = { createMessage: jest.fn().mockResolvedValue({ ok: false, reason: 'idempotency_conflict' }) };
    const service = new MatchesService(repository as never, photos as never);

    await expect(service.sendMessage(MATCH_ID, SENDER_ID, 'Autre contenu', IDEMPOTENCY_KEY)).rejects.toEqual(expect.objectContaining({
      status: 409,
      code: 'idempotency_key_conflict',
    }));
  });
});
