import type { MessageEvent, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { exhaustMap, filter, interval, map, merge, Observable, of, Subject, takeUntil, timer } from 'rxjs';
import { RefreshSessionRepository } from '../auth/refresh-session.repository';
import { RedisService } from '../redis/redis.service';
import { MOBILE_EVENT_TYPES } from './mobile.models';
import type { MobileEvent, MobileEventType } from './mobile.models';

const CHANNEL = 'histae:mobile-events:v1';
const HEARTBEAT_MILLIS = 25_000;

@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly events = new Subject<MobileEvent>();
  private unsubscribe?: () => Promise<void>;

  constructor(private readonly redis: RedisService, private readonly sessions: RefreshSessionRepository) {}

  async onModuleInit(): Promise<void> {
    if (!this.redis.enabled) return;
    this.unsubscribe = await this.redis.subscribe(CHANNEL, (message) => {
      const event = parseEvent(message);
      if (event) this.events.next(event);
      else this.logger.warn('realtime_event_invalid');
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.unsubscribe) await this.unsubscribe();
    this.events.complete();
  }

  async emit(userIds: string[], type: MobileEventType, data: MobileEvent['data']): Promise<void> {
    const occurredAt = new Date().toISOString();
    for (const userId of [...new Set(userIds)]) {
      const event: MobileEvent = { id: randomUUID(), user_id: userId, type, occurred_at: occurredAt, data };
      if (this.redis.enabled) await this.redis.publish(CHANNEL, JSON.stringify(event));
      else this.events.next(event);
    }
  }

  stream(userId: string, sessionId: string, accessExpiresAt: number): Observable<MessageEvent> {
    const connected = of<MessageEvent>({ type: 'connected', data: { server_time: new Date().toISOString() } });
    const userEvents = this.events.pipe(
      filter((event) => event.user_id === userId),
      map((event): MessageEvent => ({ id: event.id, type: event.type, data: {
        occurred_at: event.occurred_at,
        ...event.data,
      } })),
    );
    const heartbeat = interval(HEARTBEAT_MILLIS).pipe(
      map((): MessageEvent => ({ type: 'heartbeat', data: { server_time: new Date().toISOString() } })),
    );
    // Recheck across instances; Redis Pub/Sub alone cannot guarantee revocation
    // delivery. Close on the next 25s session check or at access-token expiry.
    const revoked = timer(0, HEARTBEAT_MILLIS).pipe(
      exhaustMap(() => this.sessions.isActive(userId, sessionId).catch(() => false)),
      filter((active) => !active),
    );
    return merge(connected, userEvents, heartbeat).pipe(
      takeUntil(merge(revoked, timer(Math.max(0, accessExpiresAt - Date.now())))),
    );
  }
}

function parseEvent(value: string): MobileEvent | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<MobileEvent>;
    if (typeof parsed.id !== 'string' || typeof parsed.user_id !== 'string' || typeof parsed.type !== 'string'
      || !MOBILE_EVENT_TYPES.includes(parsed.type as MobileEventType)
      || typeof parsed.occurred_at !== 'string' || typeof parsed.data !== 'object' || parsed.data === null) return undefined;
    return parsed as MobileEvent;
  } catch {
    return undefined;
  }
}
