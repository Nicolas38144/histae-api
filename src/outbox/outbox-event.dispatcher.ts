import { Injectable, Optional } from '@nestjs/common';

import { BillingReconciliationError } from '../billing/billing.errors';
import { BillingReconciliationService } from '../billing/billing-reconciliation.service';
import { NotificationPushService } from '../mobile/notification-push.service';
import { PhotosRepository } from '../photos/photos.repository';
import { ErasureService } from '../privacy/erasure.service';
import { ObjectStorageService } from '../storage/object-storage.service';
import type { OutboxEvent } from './outbox.models';

export type OutboxDispatchResult = 'completed' | 'deferred';

@Injectable()
export class OutboxEventDispatcher {
  constructor(
    private readonly photos: PhotosRepository,
    private readonly storage: ObjectStorageService,
    private readonly notifications: NotificationPushService,
    private readonly erasures: ErasureService,
    @Optional() private readonly billingReconciliation?: BillingReconciliationService,
  ) {}

  async dispatch(event: OutboxEvent, workerId: string): Promise<OutboxDispatchResult> {
    const eventType = event.eventType;
    switch (eventType) {
      case 'account.erase': {
        const completed = await this.erasures.process(event.id, workerId);
        return completed ? 'completed' : 'deferred';
      }
      case 'billing.subscription.reconcile':
      case 'billing.customer.reconcile':
        if (!this.billingReconciliation) {
          throw new BillingReconciliationError('billing_reconciliation_unavailable');
        }
        await this.billingReconciliation.process(eventType, event.aggregateId);
        return 'completed';
      case 'notification.push':
        await this.notifications.deliver(event.aggregateId);
        return 'completed';
      case 'photo.delete':
        return this.deletePhoto(event.aggregateId);
      default:
        return unsupportedEventType(eventType);
    }
  }

  private async deletePhoto(photoId: string): Promise<OutboxDispatchResult> {
    const photo = await this.photos.findDeleting(photoId);
    if (!photo) return 'completed';
    await this.storage.delete(photo.objectKey);
    await this.photos.completeDeletion(photo.id);
    return 'completed';
  }
}

function unsupportedEventType(eventType: never): never {
  throw new Error(`Unsupported outbox event type: ${String(eventType)}`);
}
