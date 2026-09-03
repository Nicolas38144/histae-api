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
      .mockResolvedValueOnce({ rowCount: 10 })
      .mockResolvedValueOnce({ rowCount: 11 })
      .mockResolvedValueOnce({ rowCount: 12 })
      .mockResolvedValueOnce({ rowCount: 13 })
      .mockResolvedValueOnce({ rowCount: 14 })
      .mockResolvedValueOnce({ rowCount: 15 })
      .mockResolvedValueOnce({ rowCount: 16 });
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
      expired_account_deletion_tokens: 11,
      expired_admin_webauthn_challenges: 12,
      expired_admin_webauthn_bootstraps: 13,
      expired_admin_sessions: 14,
      expired_admin_auth_events: 15,
      expired_outbox_operator_actions: 16,
    });
    expect(query).toHaveBeenCalledTimes(16);
    expect(query.mock.calls.every((call) => call[0].includes('LIMIT $2'))).toBe(true);
    expect(query.mock.calls[1][0]).toContain("INTERVAL '24 hours'");
    expect(query.mock.calls[5][0]).toContain("INTERVAL '5 years'");
    expect(query.mock.calls[7][0]).toContain("INTERVAL '1 year'");
    expect(query.mock.calls[13][0]).toContain("INTERVAL '24 hours'");
    expect(query.mock.calls[11][0]).toContain('UNION ALL');
    expect(query.mock.calls[12][0]).toContain('UNION ALL');
    expect(query.mock.calls[13][0]).toContain('UNION ALL');
    expect(query.mock.calls[14][0]).toContain("INTERVAL '1 year'");
    expect(query.mock.calls[15][0]).toContain("INTERVAL '1 year'");
  });
});
