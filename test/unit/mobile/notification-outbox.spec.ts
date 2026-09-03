import { enqueueNotification } from '../../../src/mobile/notification-outbox';
import { NotificationPushService } from '../../../src/mobile/notification-push.service';

describe('Transactional notification intents', () => {
  it('uses a stable source/recipient/type key and an explicit content-free allowlist', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 1 });
    const intent = { type: 'new_message' as const, matchId: 'match', messageId: 'message', senderId: 'sender', content: 'private' };
    await enqueueNotification({ query }, 'recipient', 'message', intent);
    await enqueueNotification({ query }, 'recipient', 'message', intent);
    const values = query.mock.calls[0]![1];
    expect(values[4]).toEqual(query.mock.calls[1]![1][4]);
    expect(values[3]).toEqual(JSON.stringify({ match_id: 'match', message_id: 'message', sender_id: 'sender' }));
    expect(JSON.stringify(query.mock.calls)).not.toContain('private');
    expect(query.mock.calls[0]![0]).toContain('ON CONFLICT (deduplication_key) DO NOTHING');
    expect(query.mock.calls[0]![0]).toContain("SELECT id, 'notification.push', id FROM targets");
  });

  it('propagates persistence failure so the business transaction must roll back', async () => {
    const failure = new Error('write failed');
    await expect(enqueueNotification({ query: jest.fn().mockRejectedValue(failure) }, 'user', 'event', {
      type: 'billing_payment_failed', invoiceId: 'in_test',
    })).rejects.toBe(failure);
  });
});

describe('NotificationPushService', () => {
  it('does not send an absent or ineligible delivery', async () => {
    const repository = { findDeliverable: jest.fn().mockResolvedValue(undefined) };
    const push = { sendToDevice: jest.fn() };
    await new NotificationPushService(repository as never, push as never).deliver('job');
    expect(push.sendToDevice).not.toHaveBeenCalled();
  });

  it('adds a stable notification ID and never forwards unexpected payload fields', async () => {
    const repository = { findDeliverable: jest.fn().mockResolvedValue({
      notification_id: 'notification', token: 'device', type: 'new_message',
      payload: { match_id: 'match', message_id: 'message', sender_id: 'sender', content: 'secret' },
    }) };
    const push = { sendToDevice: jest.fn().mockResolvedValue(undefined) };
    const service = new NotificationPushService(repository as never, push as never);
    await service.deliver('job');
    await service.deliver('job');
    expect(push.sendToDevice).toHaveBeenNthCalledWith(1, 'device', 'new_message', {
      notification_id: 'notification', match_id: 'match', message_id: 'message', sender_id: 'sender',
    });
    expect(push.sendToDevice.mock.calls[0]).toEqual(push.sendToDevice.mock.calls[1]);
    expect(JSON.stringify(push.sendToDevice.mock.calls)).not.toContain('secret');
  });

  it('lets delivery failures reach the outbox retry policy', async () => {
    const repository = { findDeliverable: jest.fn().mockResolvedValue({
      notification_id: 'notification', token: 'device', type: 'billing_payment_failed', payload: {},
    }) };
    const failure = new Error('delivery unavailable');
    const push = { sendToDevice: jest.fn().mockRejectedValue(failure) };
    await expect(new NotificationPushService(repository as never, push as never).deliver('job')).rejects.toBe(failure);
  });
});
