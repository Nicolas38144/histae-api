import { AdminService } from '../../../src/admin/admin.service';

const config = { legal: { termsVersion: 'terms-v1', privacyVersion: 'privacy-v1' } };

describe('AdminService', () => {
  it('maps internal cursor rows to the documented user contract', async () => {
    const repository = { listUsers: jest.fn().mockResolvedValue([{
      id: '11111111-1111-4111-8111-111111111111', role: 'user', is_banned: false, banned_at: null,
      created_at: new Date('2030-01-01T00:00:00.000Z'), firstname: 'Alice', birthdate: '1990-01-02',
      sex: 'female', photo: null, plan: 'free', onboarding_complete: true, reports_received: 1,
      matches_count: 2, cursor_at: '2030-01-01T00:00:00.000Z',
    }]) };
    const service = new AdminService(repository as never, config as never);

    await expect(service.listUsers(undefined, undefined, undefined, 20, 0)).resolves.toEqual({
      items: [expect.objectContaining({ user_id: '11111111-1111-4111-8111-111111111111', firstname: 'Alice' })],
      next_cursor: null,
    });
    expect(repository.listUsers).toHaveBeenCalledWith(undefined, undefined, '', 21, 0, undefined, 'terms-v1', 'privacy-v1');
  });

  it('requires a meaningful reason when banning an account', async () => {
    const repository = { setUserBan: jest.fn() };
    const service = new AdminService(repository as never, config as never);
    await expect(service.updateBanStatus('target', true, ' ', 'admin', 'admin'))
      .rejects.toEqual(expect.objectContaining({ status: 400, code: 'invalid_admin_request' }));
    expect(repository.setUserBan).not.toHaveBeenCalled();
  });

  it('does not hide repository authorization failures', async () => {
    const repository = { setUserBan: jest.fn().mockResolvedValue('forbidden') };
    const service = new AdminService(repository as never, config as never);
    await expect(service.updateBanStatus('target', true, 'Safety review', 'admin', 'admin'))
      .rejects.toEqual(expect.objectContaining({ status: 403, code: 'admin_action_forbidden' }));
  });

  it('rejects untraceable conversation access', async () => {
    const repository = { messages: jest.fn() };
    const service = new AdminService(repository as never, config as never);
    await expect(service.messages('match', 'admin', 'admin', '', 20, 0))
      .rejects.toEqual(expect.objectContaining({ status: 400, code: 'invalid_admin_request' }));
    expect(repository.messages).not.toHaveBeenCalled();
  });

  it('forwards the selected revenue period to the metrics query', async () => {
    const expected = { revenue: { period: 'last_7_days' } };
    const repository = { metrics: jest.fn().mockResolvedValue(expected) };
    const service = new AdminService(repository as never, config as never);

    await expect(service.metrics('last_7_days')).resolves.toBe(expected);
    expect(repository.metrics).toHaveBeenCalledWith('terms-v1', 'privacy-v1', 'last_7_days');
  });

  it('loads only the revenue aggregate for a period change', async () => {
    const expected = { period: 'previous_month', estimated_revenue_cents: 1998 };
    const repository = { revenue: jest.fn().mockResolvedValue(expected) };
    const service = new AdminService(repository as never, config as never);

    await expect(service.revenue('previous_month')).resolves.toBe(expected);
    expect(repository.revenue).toHaveBeenCalledWith('previous_month');
  });
});
