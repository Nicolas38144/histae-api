import { MatchesRepository } from '../../../src/matches/matches.repository';
import { MatchMaintenanceRepository } from '../../../src/matches/match-maintenance.repository';

describe('MatchMaintenanceRepository', () => {
  it('does not run maintenance while another worker holds the advisory lock', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ acquired: false }] }) };
    const database = { withClient: jest.fn(async (work) => work(client)) };
    const repository = new MatchMaintenanceRepository(database as never);

    await expect(repository.runMaintenanceAsLeader(new Date())).resolves.toBeUndefined();
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith('SELECT pg_try_advisory_lock($1) AS acquired', [37_142_581]);
  });

  it('executes every transition and child cleanup in one bounded batch', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 3 })
      .mockResolvedValueOnce({ rowCount: 4 })
      .mockResolvedValueOnce({ rowCount: 5 })
      .mockResolvedValueOnce({ rowCount: 6 });
    const repository = new MatchMaintenanceRepository({} as never);

    await expect(repository.runMaintenance({ query } as never, new Date('2030-01-07T12:00:00.000Z'), 50))
      .resolves.toEqual({ opened: 2, expired: 3, deleted_messages: 4, detached_reports: 5, purged: 6 });
    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls[0][0]).toContain("status = 'awaiting_continuation'");
    expect(query.mock.calls[1][0]).toContain("status = 'expired'");
    expect(query.mock.calls[2][0]).toContain('DELETE FROM chat_message');
    expect(query.mock.calls[3][0]).toContain('SET match_id = NULL');
    expect(query.mock.calls[4][0]).toContain('DELETE FROM match_init');
    expect(query.mock.calls.every((call) => call[0].includes('LIMIT $'))).toBe(true);
  });

  it('commits bounded batches while retaining one session-level leader lock', async () => {
    const counts = [2, 2, 2, 2, 2, 0, 0, 0, 0, 0];
    const client = { query: jest.fn(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('UPDATE match_init') || sql.includes('DELETE FROM chat_message')
        || sql.includes('UPDATE user_report') || sql.includes('DELETE FROM match_init')) {
        return { rowCount: counts.shift() };
      }
      return { rows: [] };
    }) };
    const database = { withClient: jest.fn(async (work) => work(client)) };
    const repository = new MatchMaintenanceRepository(database as never);

    await expect(repository.runMaintenanceAsLeader(new Date(), 2, 5)).resolves.toEqual({
      opened: 2,
      expired: 2,
      deleted_messages: 2,
      detached_reports: 2,
      purged: 2,
      batches: 2,
      work_remaining: false,
    });
    expect(client.query.mock.calls.filter(([sql]) => sql === 'BEGIN')).toHaveLength(2);
    expect(client.query.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(2);
    expect(client.query).toHaveBeenLastCalledWith('SELECT pg_advisory_unlock($1)', [37_142_581]);
  });
});

describe('MatchesRepository SQL access path', () => {
  it('merges the two participant indexes before enriching a page', async () => {
    const database = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const repository = new MatchesRepository(database as never);

    await repository.listDetailedForUser(
      '11111111-1111-4111-8111-111111111111',
      21,
      0,
    );

    const sql = String(database.query.mock.calls[0]?.[0]);
    expect(sql).toContain('page AS MATERIALIZED');
    expect(sql).toContain('UNION ALL');
    expect(sql).toContain('FROM page AS match_record');
    expect(sql.indexOf('LIMIT $2 OFFSET $3')).toBeLessThan(
      sql.indexOf('LEFT JOIN LATERAL'),
    );
  });
});
