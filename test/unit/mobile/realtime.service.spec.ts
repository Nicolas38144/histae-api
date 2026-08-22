import { firstValueFrom, filter } from 'rxjs';
import { RealtimeService } from '../../../src/mobile/realtime.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

describe('RealtimeService', () => {
  it('delivers fallback events only to their authenticated recipient', async () => {
    const service = new RealtimeService({ enabled: false } as never);
    const eventPromise = firstValueFrom(service.stream(USER_ID).pipe(filter((event) => event.type === 'message.created')));

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
    const service = new RealtimeService(redis as never);

    await service.emit([USER_ID, USER_ID, OTHER_ID], 'matches.invalidated', {});

    expect(redis.publish).toHaveBeenCalledTimes(2);
    expect(redis.publish).toHaveBeenCalledWith('histae:mobile-events:v1', expect.any(String));
  });
});
