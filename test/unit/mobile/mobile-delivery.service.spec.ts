import { MobileDeliveryService } from '../../../src/mobile/mobile-delivery.service';

const SENDER_ID = '11111111-1111-4111-8111-111111111111';
const RECIPIENT_ID = '22222222-2222-4222-8222-222222222222';

describe('MobileDeliveryService', () => {
  it('sends only realtime metadata; durable notifications belong to the business transaction', async () => {
    const realtime = { emit: jest.fn().mockResolvedValue(undefined) };
    const service = new MobileDeliveryService(realtime as never);
    const message = {
      id: '33333333-3333-4333-8333-333333333333',
      match_id: '44444444-4444-4444-8444-444444444444',
      sender_id: SENDER_ID,
      content: 'private message content',
      created_at: new Date('2030-01-01T00:00:00.000Z'),
    };

    await service.messageCreated(message, [SENDER_ID, RECIPIENT_ID]);

    const expectedMetadata = { match_id: message.match_id, message_id: message.id, sender_id: SENDER_ID };
    expect(realtime.emit).toHaveBeenCalledWith([SENDER_ID, RECIPIENT_ID], 'message.created', expectedMetadata);
    expect(JSON.stringify(realtime.emit.mock.calls)).not.toContain(message.content);
  });
});
