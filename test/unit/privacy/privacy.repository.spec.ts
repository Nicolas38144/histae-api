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
      .mockResolvedValueOnce({ rowCount: 16 })
      .mockResolvedValueOnce({ rowCount: 17 })
      .mockResolvedValueOnce({ rowCount: 18 });
    const repository = new PrivacyRepository({} as never);

    await expect(repository.runMaintenance({ query } as never, new Date('2030-01-07T12:00:00.000Z'), 1_000)).resolves.toEqual({
      stale_presences: 1,
      expired_presences: 2,
      expired_swipes: 3,
      expired_otps: 4,
      expired_refresh_tokens: 5,
      expired_notifications: 6,
      expired_consents: 7,
      expired_data_subject_requests: 8,
      expired_data_access_logs: 9,
      expired_reports: 10,
      expired_account_tombstones: 11,
      expired_account_deletion_tokens: 12,
      expired_admin_webauthn_challenges: 13,
      expired_admin_webauthn_bootstraps: 14,
      expired_admin_sessions: 15,
      expired_admin_auth_events: 16,
      expired_outbox_operator_actions: 17,
      expired_mobile_sessions: 18,
    });
    expect(query).toHaveBeenCalledTimes(18);
    expect(query.mock.calls.every((call) => call[0].includes('LIMIT $2'))).toBe(true);
    expect(query.mock.calls[1][0]).toContain("INTERVAL '24 hours'");
    expect(query.mock.calls[2][0]).toContain('DELETE FROM swipe_decision');
    expect(query.mock.calls[6][0]).toContain("INTERVAL '5 years'");
    expect(query.mock.calls[8][0]).toContain("INTERVAL '1 year'");
    expect(query.mock.calls[14][0]).toContain("INTERVAL '24 hours'");
    expect(query.mock.calls[12][0]).toContain('UNION ALL');
    expect(query.mock.calls[13][0]).toContain('UNION ALL');
    expect(query.mock.calls[14][0]).toContain('UNION ALL');
    expect(query.mock.calls[15][0]).toContain("INTERVAL '1 year'");
    expect(query.mock.calls[16][0]).toContain("INTERVAL '1 year'");
    expect(query.mock.calls[17][0]).toContain('NOT EXISTS (SELECT 1 FROM refresh_tokens');
  });
});
