import { OutboxRepository } from '../../../src/outbox/outbox.repository';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const PHOTO_ID = '22222222-2222-4222-8222-222222222222';
const WORKER_ID = '33333333-3333-4333-8333-333333333333';

describe('OutboxRepository', () => {
  it('enqueues an event through the transaction supplied by the aggregate', async () => {
    const database = { query: jest.fn() };
    const transaction = { query: jest.fn().mockResolvedValue({ rowCount: 1 }) };
    const repository = new OutboxRepository(database as never);

    await expect(repository.enqueue(transaction as never, {
      eventType: 'photo.delete',
      aggregateId: PHOTO_ID,
    })).resolves.toBe(true);

    expect(transaction.query.mock.calls[0]?.[0]).toContain(
      'INSERT INTO outbox_event',
    );
    expect(transaction.query.mock.calls[0]?.[1]).toEqual([
      expect.any(String),
      'photo.delete',
      PHOTO_ID,
      {},
    ]);
    expect(database.query).not.toHaveBeenCalled();
  });

  it('claims due and stale events with a skip-locked query', async () => {
    const event = {
      id: EVENT_ID,
      eventType: 'photo.delete',
      aggregateId: PHOTO_ID,
      payload: {},
      status: 'processing',
      attempts: 1,
    };
    const database = { query: jest.fn().mockResolvedValue({ rows: [event] }) };
    const repository = new OutboxRepository(database as never);
    const now = new Date('2026-09-02T10:00:00.000Z');
    const staleBefore = new Date('2026-09-02T09:55:00.000Z');

    await expect(repository.claimBatch(WORKER_ID, now, staleBefore, 50))
      .resolves.toEqual([event]);
    expect(database.query.mock.calls[0]?.[0]).toContain(
      'FOR UPDATE SKIP LOCKED',
    );
    expect(database.query.mock.calls[0]?.[1]).toEqual([
      WORKER_ID,
      now,
      staleBefore,
      50,
    ]);
  });

  it('resets an existing event when an operator explicitly requeues it', async () => {
    const database = { query: jest.fn() };
    const transaction = { query: jest.fn().mockResolvedValue({ rowCount: 1 }) };
    const repository = new OutboxRepository(database as never);

    await repository.requeue(transaction as never, {
      eventType: 'photo.delete',
      aggregateId: PHOTO_ID,
    });

    expect(transaction.query.mock.calls[0]?.[0]).toContain(
      "SET status = 'pending', attempts = 0",
    );
    expect(transaction.query.mock.calls[0]?.[1]).toEqual([
      expect.any(String),
      'photo.delete',
      PHOTO_ID,
      {},
    ]);
    expect(database.query).not.toHaveBeenCalled();
  });

  it.each([
    ['pending', 'pending'],
    ['dead_letter', 'dead_letter'],
    [undefined, 'not_owned'],
  ] as const)('maps retry status %s to %s', async (status, expected) => {
    const database = {
      query: jest.fn().mockResolvedValue({
        rows: status ? [{ status }] : [],
      }),
    };
    const repository = new OutboxRepository(database as never);

    await expect(repository.reschedule(
      EVENT_ID,
      WORKER_ID,
      new Date('2026-09-02T10:00:01.000Z'),
      'handler_failed',
      10,
    )).resolves.toBe(expected);
  });

  it('retries a dead letter under lock and writes the operator audit first', async () => {
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: EVENT_ID, event_type: 'photo.delete', aggregate_id: PHOTO_ID, status: 'dead_letter' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 }) };
    const database = { transaction: jest.fn(async (work) => work(client)) };
    const repository = new OutboxRepository(database as never);

    await expect(repository.retryDeadLetter(EVENT_ID, {
      userId: WORKER_ID, role: 'admin',
    }, 'Incident resolved')).resolves.toBe('updated');

    expect(client.query.mock.calls[0]?.[0]).toContain('FOR UPDATE');
    expect(client.query.mock.calls[1]?.[0]).toContain('INSERT INTO outbox_operator_action');
    expect(client.query.mock.calls[2]?.[0]).toContain("SET status = 'pending'");
  });

  it('refuses to discard a deletion while its private photo record still exists', async () => {
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ id: EVENT_ID, event_type: 'photo.delete', aggregate_id: PHOTO_ID, status: 'dead_letter' }] })
      .mockResolvedValueOnce({ rows: [{ exists: 1 }] }) };
    const database = { transaction: jest.fn(async (work) => work(client)) };
    const repository = new OutboxRepository(database as never);

    await expect(repository.discardDeadLetter(EVENT_ID, {
      userId: WORKER_ID, role: 'superadmin',
    }, 'No aggregate')).resolves.toBe('discard_not_allowed');
    expect(client.query).toHaveBeenCalledTimes(2);
  });
});
