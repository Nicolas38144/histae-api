import { Injectable } from '@nestjs/common';
import { AccountActivityService } from '../database/account-activity.service';
import { BillingService } from '../billing/billing.service';
import { PhotosService } from '../photos/photos.service';
import { DiscoveryStore } from '../discovery/discovery.store';
import { ErasureRepository, type ErasureStep } from './erasure.repository';
import { ApiError } from '../common/api-error';

export class ErasureStepError extends Error {
  constructor(readonly code: string) { super(code); }
}

@Injectable()
export class ErasureService {
  constructor(
    private readonly erasures: ErasureRepository,
    private readonly activity: AccountActivityService,
    private readonly billing: BillingService,
    private readonly photos: PhotosService,
    private readonly discovery: DiscoveryStore,
  ) {}

  /** False means the job was deferred/checkpointed, not that erasure is complete. */
  async process(eventId: string, workerId: string): Promise<boolean> {
    const initial = await this.erasures.claimed(eventId, workerId);
    if (!initial) throw new ErasureStepError('erasure_invalid_state');
    if (initial.step === 'completed') return true;
    const result = await this.activity.tryExclusive(initial.user_id, async (assertHeld) => {
      const current = await this.erasures.claimed(eventId, workerId);
      if (!current) return false;
      if (current.step === 'completed') return true;
      let next: ErasureStep = current.step;
      let partition = current.scylla_partition;
      try {
        assertHeld();
        switch (current.step) {
          case 'stripe':
            if (await this.billing.deleteCustomerForAccount(current.user_id)) next = 'photos';
            break;
          case 'photos':
            if (await this.photos.deleteForAccount(current.user_id)) next = 'scylla';
            break;
          case 'scylla':
            if (await this.discovery.deleteUserDataBatch(current.user_id, partition)) partition++;
            if (partition === 64) next = 'postgres';
            break;
          case 'postgres': next = 'completed'; break;
        }
        assertHeld();
        const advanced = await this.erasures.advance(eventId, workerId, current, next, partition);
        return advanced && next === 'completed';
      } catch (error) {
        // Never store provider messages, object keys or personal data in the job.
        if (error instanceof ErasureStepError) throw error;
        if (error instanceof ApiError && error.code === 'erasure_stripe_reconciliation_required') throw new ErasureStepError(error.code);
        throw new ErasureStepError(`erasure_${current.step}_unavailable`);
      }
    });
    if (!result.acquired) await this.erasures.defer(eventId, workerId);
    return result.acquired && result.value === true;
  }
}
