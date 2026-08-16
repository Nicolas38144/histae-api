import { MatchesRepository } from '../../../src/matches/matches.repository';

describe('MatchesRepository maintenance', () => {
  it('executes active → awaiting → expired → purge in order', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 3 })
      .mockResolvedValueOnce({ rowCount: 4 });
    const repository = new MatchesRepository({} as never);

    await expect(repository.runMaintenance({ query } as never, new Date('2030-01-07T12:00:00.000Z')))
      .resolves.toEqual({ opened: 2, expired: 3, purged: 4 });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0][0]).toContain("status = 'awaiting_continuation'");
    expect(query.mock.calls[1][0]).toContain("status = 'expired'");
    expect(query.mock.calls[2][0]).toContain('DELETE FROM match_init');
  });
});
