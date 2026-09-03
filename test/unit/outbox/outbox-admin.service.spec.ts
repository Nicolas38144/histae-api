import { OutboxAdminService } from '../../../src/outbox/outbox-admin.service';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const OPERATOR = { userId: '22222222-2222-4222-8222-222222222222', role: 'admin' as const };

describe('OutboxAdminService', () => {
  it('lists only the non-sensitive dead-letter contract', async () => {
    const outbox = { listDeadLetters: jest.fn().mockResolvedValue([{
      id: EVENT_ID,
      event_type: 'photo.delete',
      attempts: 10,
      last_error_code: 'object_storage_unavailable',
      created_at: new Date('2030-01-01T00:00:00.000Z'),
      dead_lettered_at: new Date('2030-01-02T00:00:00.000Z'),
      aggregate_id: 'not-public',
      payload: { not: 'public' },
    }]) };
    const service = new OutboxAdminService(outbox as never);

    const result = await service.deadLetters(20);
    expect(result.items).toEqual([expect.objectContaining({ event_id: EVENT_ID, event_type: 'photo.delete' })]);
    expect(result.items[0]).not.toHaveProperty('id');
    expect(result.items[0]).not.toHaveProperty('aggregate_id');
    expect(result.items[0]).not.toHaveProperty('payload');
  });

  it('normalizes audited retry reasons and maps stale state to a conflict', async () => {
    const outbox = { retryDeadLetter: jest.fn().mockResolvedValueOnce('updated').mockResolvedValueOnce('not_dead_letter') };
    const service = new OutboxAdminService(outbox as never);

    await expect(service.retry(EVENT_ID, OPERATOR, '  Incident stockage  ')).resolves.toBeUndefined();
    expect(outbox.retryDeadLetter).toHaveBeenCalledWith(EVENT_ID, OPERATOR, 'Incident stockage');
    await expect(service.retry(EVENT_ID, OPERATOR, 'Nouvelle relance'))
      .rejects.toEqual(expect.objectContaining({ status: 409, code: 'outbox_event_not_dead_letter' }));
  });

  it('fails closed when a private object can still be referenced', async () => {
    const outbox = { discardDeadLetter: jest.fn().mockResolvedValue('discard_not_allowed') };
    const service = new OutboxAdminService(outbox as never);
    await expect(service.discard(EVENT_ID, OPERATOR, 'Abandon contrôlé'))
      .rejects.toEqual(expect.objectContaining({ status: 409, code: 'outbox_discard_not_allowed' }));
  });
});
