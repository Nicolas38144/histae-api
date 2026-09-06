import { BillingReconciliationError } from '../../../src/billing/billing.errors';
import { PushDeliveryError } from '../../../src/mobile/push.service';
import type { OutboxEvent } from '../../../src/outbox/outbox.models';
import { OutboxWorkerService } from '../../../src/outbox/outbox-worker.service';
import { ObjectStorageUnavailableError } from '../../../src/storage/object-storage.service';

const EVENT: OutboxEvent = {
  id: '11111111-1111-4111-8111-111111111111',
  eventType: 'photo.delete',
  aggregateId: '22222222-2222-4222-8222-222222222222',
  payload: {},
  status: 'processing',
  attempts: 1,
};

describe('OutboxWorkerService', () => {
  it('does not dispatch a batch entry reclaimed by another worker', async () => {
    const outbox = outboxMock([EVENT]);
    outbox.renewClaim.mockResolvedValue(false);
    const dispatcher = dispatcherMock();

    await createWorker(outbox, dispatcher).runOnce();

    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(outbox.complete).not.toHaveBeenCalled();
  });

  it('acknowledges an event only after its effect succeeds', async () => {
    const order: string[] = [];
    const outbox = outboxMock([EVENT]);
    const dispatcher = dispatcherMock(async () => { order.push('effect'); return 'completed'; });
    outbox.complete.mockImplementation(async () => { order.push('ack'); return true; });

    expect((await createWorker(outbox, dispatcher).runOnce()).completed).toBe(1);
    expect(order).toEqual(['effect', 'ack']);
    expect(dispatcher.dispatch).toHaveBeenCalledWith(EVENT, expect.any(String));
  });

  it('keeps a claimed event processing when its handler reports deferred work', async () => {
    const outbox = outboxMock([EVENT]);
    const dispatcher = dispatcherMock(async () => 'deferred');

    expect(await createWorker(outbox, dispatcher).runOnce()).toEqual(expect.objectContaining({
      deferred: 1,
      completed: 0,
    }));
    expect(outbox.complete).not.toHaveBeenCalled();
    expect(outbox.reschedule).not.toHaveBeenCalled();
  });

  it('retries push failures using only a normalized error code', async () => {
    const outbox = outboxMock([{ ...EVENT, eventType: 'notification.push' }]);
    const dispatcher = dispatcherMock(async () => { throw new PushDeliveryError(); });

    expect((await createWorker(outbox, dispatcher).runOnce()).retried).toBe(1);
    expect(outbox.reschedule).toHaveBeenCalledWith(
      EVENT.id,
      expect.any(String),
      expect.any(Date),
      'push_delivery_unavailable',
      10,
    );
    expect(outbox.complete).not.toHaveBeenCalled();
  });

  it('keeps a successful but unacknowledged effect retryable', async () => {
    const outbox = outboxMock([EVENT]);
    const dispatcher = dispatcherMock();
    outbox.complete.mockRejectedValue(new Error('commit unavailable'));

    expect((await createWorker(outbox, dispatcher).runOnce()).retried).toBe(1);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it('reschedules a transient storage failure with a sanitized error code', async () => {
    const outbox = outboxMock([EVENT]);
    const dispatcher = dispatcherMock(async () => {
      throw new ObjectStorageUnavailableError(new Error('secret endpoint detail'));
    });

    expect((await createWorker(outbox, dispatcher).runOnce()).retried).toBe(1);
    expect(outbox.reschedule).toHaveBeenCalledWith(
      EVENT.id,
      expect.any(String),
      expect.any(Date),
      'object_storage_unavailable',
      10,
    );
  });

  it('reports events moved to dead letter after the retry budget', async () => {
    const outbox = outboxMock([{ ...EVENT, attempts: 10 }]);
    const dispatcher = dispatcherMock(async () => { throw new Error('database'); });
    outbox.reschedule.mockResolvedValue('dead_letter');

    const result = await createWorker(outbox, dispatcher).runOnce();

    expect(result.deadLettered).toBe(1);
    expect(result.retried).toBe(0);
  });

  it('purges completed events in multiple bounded batches and reports remaining work', async () => {
    const outbox = outboxMock([]);
    outbox.purgeCompleted.mockResolvedValueOnce(500).mockResolvedValueOnce(500);
    const config = workerConfig() as {
      maintenanceMode: string;
      workloads: { outboxPurgeBatchSize: number; outboxPurgeMaxBatches: number };
    };
    config.workloads.outboxPurgeMaxBatches = 2;

    await expect(createWorker(outbox, dispatcherMock(), config).runOnce())
      .resolves.toEqual(expect.objectContaining({
        purged: 1_000,
        purgeBatches: 2,
        workRemaining: true,
      }));
    expect(outbox.purgeCompleted).toHaveBeenCalledTimes(2);
    expect(outbox.purgeCompleted.mock.calls.every((call) => call[1] === 500)).toBe(true);
  });

  it('dead-letters a permanent Stripe reconciliation anomaly immediately', async () => {
    const event: OutboxEvent = { ...EVENT, eventType: 'billing.subscription.reconcile' };
    const outbox = outboxMock([event]);
    const dispatcher = dispatcherMock(async () => {
      throw new BillingReconciliationError('billing_mapping_conflict', true);
    });
    outbox.reschedule.mockResolvedValue('dead_letter');

    expect((await createWorker(outbox, dispatcher).runOnce()).deadLettered).toBe(1);
    expect(outbox.reschedule).toHaveBeenCalledWith(
      EVENT.id,
      expect.any(String),
      expect.any(Date),
      'billing_mapping_conflict',
      1,
    );
  });
});

function createWorker(
  outbox: Record<string, jest.Mock>,
  dispatcher: { dispatch: jest.Mock },
  config: object = workerConfig(),
): OutboxWorkerService {
  return new OutboxWorkerService(
    outbox as never,
    dispatcher as never,
    config as never,
    tracker() as never,
  );
}

function dispatcherMock(
  implementation: (event: OutboxEvent, workerId: string) => Promise<'completed' | 'deferred'> = async () => 'completed',
): { dispatch: jest.Mock } {
  return { dispatch: jest.fn(implementation) };
}

function outboxMock(events: OutboxEvent[]): Record<string, jest.Mock> {
  return {
    claimBatch: jest.fn().mockResolvedValue(events),
    renewClaim: jest.fn().mockResolvedValue(true),
    complete: jest.fn().mockResolvedValue(true),
    reschedule: jest.fn().mockResolvedValue('pending'),
    purgeCompleted: jest.fn().mockResolvedValue(2),
  };
}

function tracker(): { track: jest.Mock } {
  return { track: jest.fn(async (_job, work: () => Promise<unknown>) => work()) };
}

function workerConfig(): object {
  return {
    maintenanceMode: 'disabled',
    workloads: { outboxPurgeBatchSize: 500, outboxPurgeMaxBatches: 20 },
  };
}
