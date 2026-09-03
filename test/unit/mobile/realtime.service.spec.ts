import { firstValueFrom, filter } from 'rxjs';
import { RealtimeService } from '../../../src/mobile/realtime.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

describe('RealtimeService', () => {
  it('delivers fallback events only to their authenticated recipient', async () => {
    const service = new RealtimeService({ enabled: false } as never, { isActive: async () => true } as never);
    const eventPromise = firstValueFrom(service.stream(USER_ID, USER_ID, Date.now() + 60_000).pipe(filter((event) => event.type === 'message.created')));

    await service.emit([OTHER_ID], 'message.created', { match_id: 'ignored' });
    await service.emit([USER_ID, USER_ID], 'message.created', { match_id: 'match-id', message_id: 'message-id' });

    await expect(eventPromise).resolves.toEqual(expect.objectContaining({
      id: expect.any(String),
      type: 'message.created',
      data: expect.objectContaining({ match_id: 'match-id', message_id: 'message-id', occurred_at: expect.any(String) }),
    }));
    await service.onModuleDestroy();
  });

  it('publishes one event per distinct recipient when Redis is enabled', async () => {
    const redis = { enabled: true, publish: jest.fn().mockResolvedValue(undefined) };
    const service = new RealtimeService(redis as never, {} as never);

    await service.emit([USER_ID, USER_ID, OTHER_ID], 'matches.invalidated', {});

    expect(redis.publish).toHaveBeenCalledTimes(2);
    expect(redis.publish).toHaveBeenCalledWith('histae:mobile-events:v1', expect.any(String));
  });

  it('closes an existing stream when its session is revoked', async () => {
    jest.useFakeTimers();
    try {
      const sessions = { isActive: jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false) };
      const service = new RealtimeService({ enabled: false } as never, sessions as never);
      const completed = jest.fn();
      const subscription = service.stream(USER_ID, USER_ID, Date.now() + 60_000).subscribe({ complete: completed });
      await jest.advanceTimersByTimeAsync(0);
      expect(completed).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(25_000);
      expect(completed).toHaveBeenCalledTimes(1);
      expect(subscription.closed).toBe(true);
      await service.onModuleDestroy();
    } finally { jest.useRealTimers(); }
  });

  it('closes at access-token expiry even while the refresh family is active', async () => {
    jest.useFakeTimers();
    try {
      const service = new RealtimeService({ enabled: false } as never, { isActive: async () => true } as never);
      const subscription = service.stream(USER_ID, USER_ID, Date.now() + 1_000).subscribe();
      await jest.advanceTimersByTimeAsync(1_000);
      expect(subscription.closed).toBe(true);
      await service.onModuleDestroy();
    } finally { jest.useRealTimers(); }
  });
});
