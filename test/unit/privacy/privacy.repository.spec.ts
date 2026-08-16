import { PrivacyRepository } from '../../../src/privacy/privacy.repository';

describe('PrivacyRepository maintenance', () => {
  it('applies every retention policy in bounded batches', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 3 })
      .mockResolvedValueOnce({ rowCount: 4 })
      .mockResolvedValueOnce({ rowCount: 5 })
      .mockResolvedValueOnce({ rowCount: 6 })
      .mockResolvedValueOnce({ rowCount: 7 })
      .mockResolvedValueOnce({ rowCount: 8 })
      .mockResolvedValueOnce({ rowCount: 9 })
      .mockResolvedValueOnce({ rowCount: 10 });
    const repository = new PrivacyRepository({} as never);

    await expect(repository.runMaintenance({ query } as never, new Date('2030-01-07T12:00:00.000Z'), 1_000)).resolves.toEqual({
      stale_presences: 1,
      expired_presences: 2,
      expired_otps: 3,
      expired_refresh_tokens: 4,
      expired_notifications: 5,
      expired_consents: 6,
      expired_data_subject_requests: 7,
      expired_data_access_logs: 8,
      expired_reports: 9,
      expired_account_tombstones: 10,
    });
    expect(query).toHaveBeenCalledTimes(10);
    expect(query.mock.calls.every((call) => call[0].includes('LIMIT $2'))).toBe(true);
    expect(query.mock.calls[1][0]).toContain("INTERVAL '24 hours'");
    expect(query.mock.calls[5][0]).toContain("INTERVAL '5 years'");
    expect(query.mock.calls[7][0]).toContain("INTERVAL '1 year'");
  });
});
