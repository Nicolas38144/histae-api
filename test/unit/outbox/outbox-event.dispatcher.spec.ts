import { OutboxEventDispatcher } from '../../../src/outbox/outbox-event.dispatcher';
import type { OutboxEvent, OutboxEventType } from '../../../src/outbox/outbox.models';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const AGGREGATE_ID = '22222222-2222-4222-8222-222222222222';
const WORKER_ID = '33333333-3333-4333-8333-333333333333';
const PHOTO = {
  id: AGGREGATE_ID,
  userId: '44444444-4444-4444-8444-444444444444',
  objectKey: `profile-photos/44444444-4444-4444-8444-444444444444/${AGGREGATE_ID}.webp`,
  status: 'deleting',
};

describe('OutboxEventDispatcher', () => {
  it('passes the claim identity to resumable account erasure', async () => {
    const dependencies = dependencyMocks();
    dependencies.erasures.process.mockResolvedValue(false);
    const dispatcher = createDispatcher(dependencies);

    await expect(dispatcher.dispatch(event('account.erase'), WORKER_ID)).resolves.toBe('deferred');
    expect(dependencies.erasures.process).toHaveBeenCalledWith(EVENT_ID, WORKER_ID);
  });

  it('delivers one notification by its durable aggregate ID', async () => {
    const dependencies = dependencyMocks();
    const dispatcher = createDispatcher(dependencies);

    await expect(dispatcher.dispatch(event('notification.push'), WORKER_ID)).resolves.toBe('completed');
    expect(dependencies.notifications.deliver).toHaveBeenCalledWith(AGGREGATE_ID);
  });

  it.each([
    'billing.subscription.reconcile',
    'billing.customer.reconcile',
  ] as const)('routes %s to Stripe reconciliation', async (eventType) => {
    const dependencies = dependencyMocks();
    const dispatcher = createDispatcher(dependencies);

    await expect(dispatcher.dispatch(event(eventType), WORKER_ID)).resolves.toBe('completed');
    expect(dependencies.billing.process).toHaveBeenCalledWith(eventType, AGGREGATE_ID);
  });

  it('keeps a missing Stripe reconciler as a normalized retryable failure', async () => {
    const dependencies = dependencyMocks();
    const dispatcher = new OutboxEventDispatcher(
      dependencies.photos as never,
      dependencies.storage as never,
      dependencies.notifications as never,
      dependencies.erasures as never,
    );

    await expect(dispatcher.dispatch(event('billing.customer.reconcile'), WORKER_ID))
      .rejects.toMatchObject({
        code: 'billing_reconciliation_unavailable',
        permanent: false,
      });
  });

  it('deletes a photo object before completing its database lifecycle', async () => {
    const order: string[] = [];
    const dependencies = dependencyMocks();
    dependencies.photos.findDeleting.mockResolvedValue(PHOTO);
    dependencies.storage.delete.mockImplementation(async () => { order.push('object'); });
    dependencies.photos.completeDeletion.mockImplementation(async () => { order.push('database'); });
    const dispatcher = createDispatcher(dependencies);

    await expect(dispatcher.dispatch(event('photo.delete'), WORKER_ID)).resolves.toBe('completed');
    expect(dependencies.storage.delete).toHaveBeenCalledWith(PHOTO.objectKey);
    expect(dependencies.photos.completeDeletion).toHaveBeenCalledWith(PHOTO.id);
    expect(order).toEqual(['object', 'database']);
  });

  it('treats an already removed photo aggregate as completed', async () => {
    const dependencies = dependencyMocks();
    const dispatcher = createDispatcher(dependencies);

    await expect(dispatcher.dispatch(event('photo.delete'), WORKER_ID)).resolves.toBe('completed');
    expect(dependencies.storage.delete).not.toHaveBeenCalled();
    expect(dependencies.photos.completeDeletion).not.toHaveBeenCalled();
  });

  it('fails explicitly if an unregistered event type reaches the dispatcher', async () => {
    const dependencies = dependencyMocks();
    const dispatcher = createDispatcher(dependencies);
    const unsupported = { ...event('photo.delete'), eventType: 'unknown.event' } as unknown as OutboxEvent;

    await expect(dispatcher.dispatch(unsupported, WORKER_ID))
      .rejects.toThrow('Unsupported outbox event type: unknown.event');
  });
});

function event(eventType: OutboxEventType): OutboxEvent {
  return {
    id: EVENT_ID,
    eventType,
    aggregateId: AGGREGATE_ID,
    payload: {},
    status: 'processing',
    attempts: 1,
  };
}

function dependencyMocks() {
  return {
    photos: {
      findDeleting: jest.fn().mockResolvedValue(undefined),
      completeDeletion: jest.fn().mockResolvedValue(undefined),
    },
    storage: { delete: jest.fn().mockResolvedValue(undefined) },
    notifications: { deliver: jest.fn().mockResolvedValue(undefined) },
    erasures: { process: jest.fn().mockResolvedValue(true) },
    billing: { process: jest.fn().mockResolvedValue(undefined) },
  };
}

function createDispatcher(dependencies: ReturnType<typeof dependencyMocks>): OutboxEventDispatcher {
  return new OutboxEventDispatcher(
    dependencies.photos as never,
    dependencies.storage as never,
    dependencies.notifications as never,
    dependencies.erasures as never,
    dependencies.billing as never,
  );
}
