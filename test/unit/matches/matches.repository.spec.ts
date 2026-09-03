import { MatchesRepository } from '../../../src/matches/matches.repository';
import { MatchMaintenanceRepository } from '../../../src/matches/match-maintenance.repository';

describe('MatchMaintenanceRepository', () => {
  it('does not run maintenance while another worker holds the advisory lock', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ acquired: false }] }) };
    const database = { transaction: jest.fn(async (work) => work(client)) };
    const repository = new MatchMaintenanceRepository(database as never);

    await expect(repository.runMaintenanceAsLeader(new Date())).resolves.toBeUndefined();
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith('SELECT pg_try_advisory_xact_lock($1) AS acquired', [37_142_581]);
  });

  it('executes active → awaiting → expired → purge in order', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 3 })
      .mockResolvedValueOnce({ rowCount: 4 });
    const repository = new MatchMaintenanceRepository({} as never);

    await expect(repository.runMaintenance({ query } as never, new Date('2030-01-07T12:00:00.000Z')))
      .resolves.toEqual({ opened: 2, expired: 3, purged: 4 });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0][0]).toContain("status = 'awaiting_continuation'");
    expect(query.mock.calls[1][0]).toContain("status = 'expired'");
    expect(query.mock.calls[2][0]).toContain('DELETE FROM match_init');
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
