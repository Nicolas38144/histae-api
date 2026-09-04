import { accountActivityStub } from "../../account-activity.stub";
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DiscoveryStore, uuidBucket } from '../../../src/discovery/discovery.store';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';

describe('DiscoveryStore', () => {
  it('relies on the fixed table TTL for a new swipe and writes both query views', async () => {
    const appliedResult = { wasApplied: () => true, first: () => undefined };
    const scylla = { enabled: true, execute: jest.fn().mockResolvedValue(appliedResult) };
    const store = new DiscoveryStore(scylla as never, accountActivityStub);

    await expect(store.recordSwipe(ACTOR_ID, TARGET_ID, 'like')).resolves.toEqual({ created: true, decision: 'like' });

    expect(scylla.execute).toHaveBeenCalledTimes(2);
    expect(scylla.execute.mock.calls[0][0]).toContain('IF NOT EXISTS');
    expect(scylla.execute.mock.calls[0][0]).not.toContain('USING TTL');
    expect(scylla.execute.mock.calls[0][1]).toEqual([
      ACTOR_ID, uuidBucket(TARGET_ID), TARGET_ID, 'like', expect.any(Date),
    ]);
    expect(scylla.execute.mock.calls[1][0]).toContain('swipes_by_target_bucket');
    expect(scylla.execute.mock.calls[1][0]).not.toContain('USING TTL');
    expect(scylla.execute.mock.calls[1][1]).toEqual([
      TARGET_ID, uuidBucket(ACTOR_ID), ACTOR_ID, 'like', expect.any(Date),
    ]);

    const schema = readFileSync(join(process.cwd(), 'scylla', '001_discovery.cql'), 'utf8');
    expect(schema.match(/default_time_to_live = 31536000/g)).toHaveLength(2);
    expect(schema.match(/'class': 'TimeWindowCompactionStrategy'/g)).toHaveLength(2);
    expect(schema.match(/'compaction_window_size': '14'/g)).toHaveLength(2);
  });

  it('does not extend the original one-year retention when repairing a mirror', async () => {
    const storedAt = new Date('2030-01-01T00:00:00.000Z');
    const row = { get: (column: string) => column === 'decision' ? 'like' : column === 'swiped_at' ? storedAt : 31_535_900 };
    const lwtResult = { wasApplied: () => false };
    const readResult = { first: () => row };
    const mirrorResult = { wasApplied: () => true };
    const scylla = { enabled: true, execute: jest.fn()
      .mockResolvedValueOnce(lwtResult)
      .mockResolvedValueOnce(readResult)
      .mockResolvedValueOnce(mirrorResult) };
    const store = new DiscoveryStore(scylla as never, accountActivityStub);

    await expect(store.recordSwipe(ACTOR_ID, TARGET_ID, 'like')).resolves.toEqual({ created: false, decision: 'like' });
    expect(scylla.execute.mock.calls[1][0]).toContain('TTL(decision) AS remaining_ttl');
    expect(scylla.execute.mock.calls[2][0]).toContain('USING TTL ?');
    expect(scylla.execute.mock.calls[2][1]).toEqual([
      TARGET_ID, uuidBucket(ACTOR_ID), ACTOR_ID, 'like', storedAt, 31_535_900,
    ]);
  });

  it('maps valid UUIDs to one of the fixed 32 buckets', () => {
    expect(uuidBucket(ACTOR_ID)).toBeGreaterThanOrEqual(0);
    expect(uuidBucket(ACTOR_ID)).toBeLessThan(32);
    expect(uuidBucket(ACTOR_ID)).toBe(uuidBucket(ACTOR_ID));
    expect(() => uuidBucket('not-a-uuid')).toThrow('invalid UUID');
  });

  it('keeps the source reference until its counterpart deletion is confirmed', async () => {
    const scylla = { enabled: true, execute: jest.fn()
      .mockResolvedValueOnce({ rows: [{ get: () => TARGET_ID }] })
      .mockRejectedValueOnce(new Error('lost mirror deletion response')) };
    const store = new DiscoveryStore(scylla as never, accountActivityStub);
    await expect(store.deleteUserDataBatch(ACTOR_ID, uuidBucket(TARGET_ID))).rejects.toThrow('lost mirror');
    expect(scylla.execute).toHaveBeenCalledTimes(2);
    expect(scylla.execute.mock.calls[0][0]).toContain('LIMIT 100');
    expect(scylla.execute.mock.calls[1][0]).toContain('DELETE FROM swipes_by_target_bucket');
  });

  it('does not mistake a full page for the end of a Scylla partition', async () => {
    const scylla = { enabled: true, execute: jest.fn().mockResolvedValue({ rows: [] }) };
    scylla.execute.mockResolvedValueOnce({ rows: Array.from({ length: 100 }, () => ({ get: () => TARGET_ID })) });
    const store = new DiscoveryStore(scylla as never, accountActivityStub);
    await expect(store.deleteUserDataBatch(ACTOR_ID, uuidBucket(TARGET_ID))).resolves.toBe(false);
    expect(scylla.execute).toHaveBeenCalledTimes(201);
    await expect(store.deleteUserDataBatch(ACTOR_ID, uuidBucket(TARGET_ID))).resolves.toBe(true);
  });

  it('fails closed when Scylla is disabled during erasure', async () => {
    const scylla = { enabled: false, execute: jest.fn() };
    await expect(new DiscoveryStore(scylla as never, accountActivityStub).deleteUserDataBatch(ACTOR_ID, 0)).rejects.toThrow('disabled');
    expect(scylla.execute).not.toHaveBeenCalled();
  });
});
