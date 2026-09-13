import { accountActivityStub } from '../../account-activity.stub';
import { DiscoveryPersistenceError, DiscoveryStore } from '../../../src/discovery/discovery.store';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';

describe('DiscoveryStore', () => {
  it('creates one canonical PostgreSQL row with a fixed 365-day retention', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [{ decision: 'like' }] });
    const store = new DiscoveryStore(database(query) as never, accountActivityStub);

    await expect(store.recordSwipe(ACTOR_ID, TARGET_ID, 'like')).resolves.toEqual({
      created: true,
      decision: 'like',
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('INSERT INTO swipe_decision');
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT (actor_id, target_id) DO NOTHING');
    expect(query.mock.calls[0][1]).toEqual([
      ACTOR_ID, TARGET_ID, 'like', expect.any(Date), 365,
    ]);
  });

  it('keeps the first unexpired decision immutable on a conflicting retry', async () => {
    const original = new Date('2030-01-01T00:00:00.000Z');
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        actor_id: ACTOR_ID,
        target_id: TARGET_ID,
        decision: 'pass',
        swiped_at: original,
        expires_at: new Date(Date.now() + 60_000),
      }] });
    const store = new DiscoveryStore(database(query) as never, accountActivityStub);

    await expect(store.recordSwipe(ACTOR_ID, TARGET_ID, 'like')).resolves.toEqual({
      created: false,
      decision: 'pass',
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain('FOR UPDATE');
  });

  it('allows a fresh decision only after the original retention expires', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        actor_id: ACTOR_ID,
        target_id: TARGET_ID,
        decision: 'pass',
        swiped_at: new Date('2020-01-01T00:00:00.000Z'),
        expires_at: new Date('2021-01-01T00:00:00.000Z'),
      }] })
      .mockResolvedValueOnce({ rows: [{ decision: 'like' }] });
    const store = new DiscoveryStore(database(query) as never, accountActivityStub);

    await expect(store.recordSwipe(ACTOR_ID, TARGET_ID, 'like')).resolves.toEqual({
      created: true,
      decision: 'like',
    });
    expect(query.mock.calls[2][0]).toContain('UPDATE swipe_decision');
  });

  it('uses one indexed PostgreSQL query for a batch of feed exclusions', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ target_id: TARGET_ID }] });
    const store = new DiscoveryStore({ query } as never, accountActivityStub);

    await expect(store.swipedTargetIds(ACTOR_ID, [TARGET_ID])).resolves.toEqual(new Set([TARGET_ID]));
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('target_id = ANY($2::uuid[])');
    expect(query.mock.calls[0][0]).toContain('expires_at > clock_timestamp()');
  });

  it('normalizes PostgreSQL swipe failures for the public discovery service', async () => {
    const query = jest.fn().mockRejectedValue(new Error('private database detail'));
    const store = new DiscoveryStore({ query } as never, accountActivityStub);

    await expect(store.findSwipe(ACTOR_ID, TARGET_ID)).rejects.toBeInstanceOf(DiscoveryPersistenceError);
  });
});

function database(query: jest.Mock) {
  return {
    query,
    transaction: <T>(work: (client: { query: jest.Mock }) => Promise<T>) => work({ query }),
  };
}
