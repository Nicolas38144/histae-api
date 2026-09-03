import { OperationalStatusService } from '../../../src/operations/operational-status.service';

describe('OperationalStatusService', () => {
  it('exposes missing and overdue maintenance plus outbox and pool pressure', async () => {
    const metrics = {
      startedAt: new Date('2030-01-01T00:00:00.000Z'),
      runtimeSnapshot: jest.fn().mockReturnValue({ uptime_seconds: 10 }),
      httpSnapshot: jest.fn().mockReturnValue({ requests: 2 }),
      dependencySnapshot: jest.fn().mockReturnValue({ postgres: { calls: 1 } }),
    };
    const database = { poolStats: jest.fn().mockReturnValue({ total: 5, idle: 1, waiting: 2 }) };
    const outbox = { statusSnapshot: jest.fn().mockResolvedValue({ pending: 3, dead_letter: 1 }) };
    const maintenance = { list: jest.fn().mockResolvedValue([{
      job_name: 'matches',
      status: 'succeeded',
      started_at: new Date('2030-01-01T00:00:00.000Z'),
      finished_at: new Date('2030-01-01T00:01:00.000Z'),
      last_succeeded_at: new Date('2030-01-01T00:01:00.000Z'),
      duration_ms: 60_000,
      processed_count: 2,
      last_error_code: null,
    }]) };
    const config = {
      rateLimit: { store: 'memory' }, scylla: { enabled: false },
      sms: { provider: 'disabled' }, billing: { provider: 'disabled' },
    };
    const service = new OperationalStatusService(
      metrics as never, database as never, outbox as never, maintenance as never, config as never,
    );

    const snapshot = await service.snapshot(new Date('2030-01-02T00:00:00.000Z'));
    expect(snapshot.postgres_pool).toEqual({ total: 5, idle: 1, waiting: 2 });
    expect(snapshot.outbox).toEqual(expect.objectContaining({ dead_letter: 1 }));
    expect(snapshot.maintenance).toEqual(expect.arrayContaining([
      expect.objectContaining({ job_name: 'matches', missing: false, overdue: true }),
      expect.objectContaining({ job_name: 'photos', missing: true, overdue: true }),
    ]));
  });
});
