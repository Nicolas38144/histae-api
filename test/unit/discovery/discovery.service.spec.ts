import { DiscoveryService } from '../../../src/discovery/discovery.service';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const FIRST_TARGET_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_TARGET_ID = '33333333-3333-4333-8333-333333333333';
const THIRD_TARGET_ID = '44444444-4444-4444-8444-444444444444';

describe('DiscoveryService', () => {
  const config = {
    legal: { sensitiveDataConsentVersion: 'sensitive-v1', locationConsentVersion: 'location-v1' },
  };

  it('returns every missing prerequisite required to enter discovery', async () => {
    const presenceExpiresAt = new Date('2030-01-01T12:00:00.000Z');
    const repository = { discoveryStatus: jest.fn().mockResolvedValue({
      has_profile: true,
      has_sex: false,
      has_preferences: false,
      has_sensitive_consent: false,
      has_location_consent: true,
      has_fresh_presence: false,
      presence_expires_at: presenceExpiresAt,
    }) };
    const service = new DiscoveryService(repository as never, {} as never, {} as never, config as never);

    await expect(service.status(ACTOR_ID)).resolves.toEqual({
      ready: false,
      required_actions: ['sex', 'preferences', 'sensitive_data_consent', 'fresh_presence'],
      presence_expires_at: presenceExpiresAt,
    });
    expect(repository.discoveryStatus).toHaveBeenCalledWith(ACTOR_ID, 'sensitive-v1', 'location-v1');
  });

  it('reports discovery ready when no prerequisite is missing', async () => {
    const repository = { discoveryStatus: jest.fn().mockResolvedValue({
      has_profile: true,
      has_sex: true,
      has_preferences: true,
      has_sensitive_consent: true,
      has_location_consent: true,
      has_fresh_presence: true,
      presence_expires_at: new Date('2030-01-01T12:00:00.000Z'),
    }) };
    const service = new DiscoveryService(repository as never, {} as never, {} as never, config as never);

    await expect(service.status(ACTOR_ID)).resolves.toEqual(expect.objectContaining({ ready: true, required_actions: [] }));
  });

  it('filters already-swiped profiles and keeps exact distance in its opaque cursor', async () => {
    const repository = {
      isDiscoveryReady: jest.fn().mockResolvedValue(true),
      candidateBatch: jest.fn().mockResolvedValueOnce([
        candidate(FIRST_TARGET_ID, 1.23456),
        candidate(SECOND_TARGET_ID, 2.5),
        candidate(THIRD_TARGET_ID, 3.5),
      ]),
    };
    const store = {
      available: true,
      swipedTargetIds: jest.fn().mockResolvedValue(new Set([SECOND_TARGET_ID])),
    };
    const service = new DiscoveryService(repository as never, store as never, {} as never, config as never);

    const result = await service.feed(ACTOR_ID, 1);

    expect(result.profiles).toEqual([expect.objectContaining({ user_id: FIRST_TARGET_ID, distance_km: 1.2 })]);
    expect(result.next_cursor).not.toBeNull();
    expect(JSON.parse(Buffer.from(result.next_cursor!, 'base64url').toString('utf8'))).toEqual({
      distance_km: 1.23456,
      id: FIRST_TARGET_ID,
    });
    expect(store.swipedTargetIds).toHaveBeenCalledWith(ACTOR_ID, [FIRST_TARGET_ID, SECOND_TARGET_ID, THIRD_TARGET_ID]);
  });

  it('creates a PostgreSQL match only after reciprocal likes', async () => {
    const match = { id: '44444444-4444-4444-8444-444444444444' };
    const repository = {
      isDiscoveryReady: jest.fn().mockResolvedValue(true),
      isSwipeTargetAvailable: jest.fn().mockResolvedValue(true),
    };
    const store = {
      available: true,
      recordSwipe: jest.fn().mockResolvedValue({ created: true, decision: 'like' }),
      findSwipe: jest.fn().mockResolvedValue({ decision: 'like' }),
    };
    const matches = { createFromMutualLike: jest.fn().mockResolvedValue(match) };
    const service = new DiscoveryService(repository as never, store as never, matches as never, config as never);

    await expect(service.swipe(ACTOR_ID, FIRST_TARGET_ID, 'like')).resolves.toEqual({
      decision: 'like', matched: true, match,
    });
    expect(matches.createFromMutualLike).toHaveBeenCalledWith(ACTOR_ID, FIRST_TARGET_ID);
  });

  it('rejects attempts to overwrite an immutable swipe decision', async () => {
    const repository = {
      isDiscoveryReady: jest.fn().mockResolvedValue(true),
      isSwipeTargetAvailable: jest.fn().mockResolvedValue(true),
    };
    const store = {
      available: true,
      recordSwipe: jest.fn().mockResolvedValue({ created: false, decision: 'pass' }),
    };
    const service = new DiscoveryService(repository as never, store as never, {} as never, config as never);

    await expect(service.swipe(ACTOR_ID, FIRST_TARGET_ID, 'like')).rejects.toEqual(expect.objectContaining({
      status: 409,
      code: 'swipe_already_recorded',
    }));
  });

  it('fails closed when Scylla-backed discovery is disabled', async () => {
    const service = new DiscoveryService({} as never, { available: false } as never, {} as never, config as never);

    await expect(service.feed(ACTOR_ID, 20)).rejects.toEqual(expect.objectContaining({
      status: 503,
      code: 'discovery_unavailable',
    }));
  });
});

function candidate(userId: string, distanceKm: number) {
  return {
    user_id: userId,
    firstname: 'Candidate',
    age: 30,
    sex: 'female' as const,
    bio: null,
    distance_km: distanceKm,
    traits: ['Curieux'],
  };
}
