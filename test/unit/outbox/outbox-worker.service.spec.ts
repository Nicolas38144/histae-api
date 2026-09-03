import { OutboxWorkerService } from '../../../src/outbox/outbox-worker.service';
import { ObjectStorageUnavailableError } from '../../../src/storage/object-storage.service';

const EVENT = {
  id: '11111111-1111-4111-8111-111111111111',
  eventType: 'photo.delete',
  aggregateId: '22222222-2222-4222-8222-222222222222',
  payload: {},
  status: 'processing',
  attempts: 1,
};
const PHOTO = {
  id: EVENT.aggregateId,
  userId: '33333333-3333-4333-8333-333333333333',
  objectKey: `profile-photos/33333333-3333-4333-8333-333333333333/${EVENT.aggregateId}.webp`,
  status: 'deleting',
};

describe('OutboxWorkerService', () => {
  it('deletes the object and completes its database lifecycle', async () => {
    const outbox = outboxMock([EVENT]);
    const photos = {
      findDeleting: jest.fn().mockResolvedValue(PHOTO),
      completeDeletion: jest.fn().mockResolvedValue(undefined),
    };
    const storage = { delete: jest.fn().mockResolvedValue(undefined) };
    const worker = new OutboxWorkerService(
      outbox as never,
      photos as never,
      storage as never,
      { maintenanceMode: 'disabled' } as never,
      tracker() as never,
    );

    await expect(worker.runOnce(new Date('2026-09-02T10:00:00.000Z')))
      .resolves.toEqual({
        claimed: 1,
        completed: 1,
        retried: 0,
        deadLettered: 0,
        purged: 2,
      });
    expect(storage.delete).toHaveBeenCalledWith(PHOTO.objectKey);
    expect(photos.completeDeletion).toHaveBeenCalledWith(PHOTO.id);
    expect(outbox.complete).toHaveBeenCalledWith(
      EVENT.id,
      expect.any(String),
      expect.any(Date),
    );
  });

  it('completes an event whose aggregate was already removed', async () => {
    const outbox = outboxMock([EVENT]);
    const photos = {
      findDeleting: jest.fn().mockResolvedValue(undefined),
      completeDeletion: jest.fn(),
    };
    const storage = { delete: jest.fn() };
    const worker = new OutboxWorkerService(
      outbox as never,
      photos as never,
      storage as never,
      { maintenanceMode: 'disabled' } as never,
      tracker() as never,
    );

    const result = await worker.runOnce();
    expect(result.completed).toBe(1);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(photos.completeDeletion).not.toHaveBeenCalled();
  });

  it('reschedules a transient storage failure with a sanitized error code', async () => {
    const outbox = outboxMock([EVENT]);
    outbox.reschedule.mockResolvedValue('pending');
    const photos = {
      findDeleting: jest.fn().mockResolvedValue(PHOTO),
      completeDeletion: jest.fn(),
    };
    const storage = {
      delete: jest.fn().mockRejectedValue(
        new ObjectStorageUnavailableError(new Error('secret endpoint detail')),
      ),
    };
    const worker = new OutboxWorkerService(
      outbox as never,
      photos as never,
      storage as never,
      { maintenanceMode: 'disabled' } as never,
      tracker() as never,
    );

    const result = await worker.runOnce();
    expect(result.retried).toBe(1);
    expect(result.completed).toBe(0);
    expect(outbox.reschedule).toHaveBeenCalledWith(
      EVENT.id,
      expect.any(String),
      expect.any(Date),
      'object_storage_unavailable',
      10,
    );
    expect(outbox.complete).not.toHaveBeenCalled();
  });

  it('reports events moved to dead letter after the retry budget', async () => {
    const outbox = outboxMock([{ ...EVENT, attempts: 10 }]);
    outbox.reschedule.mockResolvedValue('dead_letter');
    const worker = new OutboxWorkerService(
      outbox as never,
      { findDeleting: jest.fn().mockRejectedValue(new Error('database')) } as never,
      {} as never,
      { maintenanceMode: 'disabled' } as never,
      tracker() as never,
    );

    const result = await worker.runOnce();
    expect(result.deadLettered).toBe(1);
    expect(result.retried).toBe(0);
  });
});

function outboxMock(events: unknown[]): Record<string, jest.Mock> {
  return {
    claimBatch: jest.fn().mockResolvedValue(events),
    complete: jest.fn().mockResolvedValue(true),
    reschedule: jest.fn().mockResolvedValue('pending'),
    purgeCompleted: jest.fn().mockResolvedValue(2),
  };
}

function tracker(): { track: jest.Mock } {
  return { track: jest.fn(async (_job, work: () => Promise<unknown>) => work()) };
}
