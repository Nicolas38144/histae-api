import { randomUUID } from 'node:crypto';

import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';

import { ConfigService } from '../config/config.service';
import { PhotosRepository } from '../photos/photos.repository';
import {
  ObjectStorageService,
  ObjectStorageUnavailableError,
} from '../storage/object-storage.service';
import { OUTBOX_LOCK_TIMEOUT_MILLIS } from './outbox.constants';
import type { OutboxEvent, OutboxWorkerResult } from './outbox.models';
import { OutboxRepository } from './outbox.repository';

const POLL_INTERVAL_MILLIS = 1_000;
const COMPLETED_RETENTION_MILLIS = 7 * 24 * 60 * 60 * 1_000;
const COMPLETED_PURGE_INTERVAL_MILLIS = 60 * 60 * 1_000;
const BATCH_SIZE = 50;
const HANDLER_CONCURRENCY = 5;
const MAX_ATTEMPTS = 10;
const MAX_RETRY_DELAY_MILLIS = 60_000;

@Injectable()
export class OutboxWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorkerService.name);
  private readonly workerId = randomUUID();
  private timer?: NodeJS.Timeout;
  private polling = false;
  private lastCompletedPurgeAt?: number;

  constructor(
    private readonly outbox: OutboxRepository,
    private readonly photos: PhotosRepository,
    private readonly storage: ObjectStorageService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.maintenanceMode !== 'api') return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MILLIS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(now = new Date()): Promise<OutboxWorkerResult> {
    const events = await this.outbox.claimBatch(
      this.workerId,
      now,
      new Date(now.getTime() - OUTBOX_LOCK_TIMEOUT_MILLIS),
      BATCH_SIZE,
    );
    const result: OutboxWorkerResult = {
      claimed: events.length,
      completed: 0,
      retried: 0,
      deadLettered: 0,
      purged: 0,
    };

    for (let offset = 0; offset < events.length; offset += HANDLER_CONCURRENCY) {
      const group = events.slice(offset, offset + HANDLER_CONCURRENCY);
      await Promise.all(group.map((event) => this.process(event, result)));
    }

    if (this.lastCompletedPurgeAt === undefined
      || now.getTime() - this.lastCompletedPurgeAt >= COMPLETED_PURGE_INTERVAL_MILLIS) {
      result.purged = await this.outbox.purgeCompleted(
        new Date(now.getTime() - COMPLETED_RETENTION_MILLIS),
        BATCH_SIZE,
      );
      this.lastCompletedPurgeAt = now.getTime();
    }
    return result;
  }

  async runUntilStopped(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await this.poll();
      await waitForNextPoll(signal);
    }
  }

  private async process(
    event: OutboxEvent,
    result: OutboxWorkerResult,
  ): Promise<void> {
    try {
      await this.dispatch(event);
      if (await this.outbox.complete(event.id, this.workerId, new Date())) {
        result.completed += 1;
      }
    } catch (error: unknown) {
      const retry = await this.outbox.reschedule(
        event.id,
        this.workerId,
        new Date(Date.now() + retryDelayMillis(event.attempts)),
        outboxErrorCode(error),
        MAX_ATTEMPTS,
      );
      if (retry === 'pending') result.retried += 1;
      if (retry === 'dead_letter') {
        result.deadLettered += 1;
        this.logger.error(
          `Outbox event ${event.id} (${event.eventType}) moved to dead letter`,
        );
      }
    }
  }

  private async dispatch(event: OutboxEvent): Promise<void> {
    if (event.eventType === 'photo.delete') {
      const photo = await this.photos.findDeleting(event.aggregateId);
      if (!photo) return;
      await this.storage.delete(photo.objectKey);
      await this.photos.completeDeletion(photo.id);
      return;
    }
    throw new Error('Unsupported outbox event type');
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.runOnce();
    } catch (error: unknown) {
      this.logger.error(
        'Outbox polling failed',
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      this.polling = false;
    }
  }
}

function retryDelayMillis(attempts: number): number {
  return Math.min(1_000 * (2 ** Math.max(0, attempts - 1)), MAX_RETRY_DELAY_MILLIS);
}

function outboxErrorCode(error: unknown): string {
  return error instanceof ObjectStorageUnavailableError
    ? 'object_storage_unavailable'
    : 'handler_failed';
}

function waitForNextPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, POLL_INTERVAL_MILLIS);
    signal.addEventListener('abort', finish, { once: true });
  });
}
