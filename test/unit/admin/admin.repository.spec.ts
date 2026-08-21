import { AdminRepository } from '../../../src/admin/admin.repository';

describe('AdminRepository account safety', () => {
  it('prevents an administrator from banning another administrator', async () => {
    const client = { query: jest.fn().mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) };
    const database = { transaction: jest.fn((callback) => callback(client)) };
    const repository = new AdminRepository(database as never);

    await expect(repository.setUserBan('target', true, 'reason', 'actor', 'admin')).resolves.toBe('forbidden');
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('revokes refresh tokens and records an audit event when banning a user', async () => {
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ role: 'user' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValueOnce({ rowCount: 1 }) };
    const database = { transaction: jest.fn((callback) => callback(client)) };
    const repository = new AdminRepository(database as never);

    await expect(repository.setUserBan('target', true, 'Safety incident', 'actor', 'admin')).resolves.toBe('updated');
    expect(client.query.mock.calls[2][0]).toContain('UPDATE refresh_tokens SET revoked = true');
    expect(client.query.mock.calls[3][0]).toContain('data_access_log');
    expect(client.query.mock.calls[3][1]).toContain('admin_ban');
  });
});

describe('AdminRepository revenue', () => {
  it('calculates an explicitly labelled Premium revenue estimate for the selected period', async () => {
    const database = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{
        period_start: new Date('2030-01-01T00:00:00.000Z'),
        period_end: new Date('2030-02-01T00:00:00.000Z'),
        premium_subscriptions: 2,
        price_per_subscription_cents: 999,
        estimated_revenue_cents: '1998',
        currency: 'EUR',
      }] }) };
    const repository = new AdminRepository(database as never);

    const revenue = await repository.revenue('previous_month');

    expect(revenue).toEqual({
      period: 'previous_month',
      period_start: new Date('2030-01-01T00:00:00.000Z'),
      period_end: new Date('2030-02-01T00:00:00.000Z'),
      premium_subscriptions: 2,
      price_per_subscription_cents: 999,
      estimated_revenue_cents: 1998,
      currency: 'EUR',
      basis: 'premium_monthly_price',
    });
    expect(database.query.mock.calls[0][0]).toContain('subscription.updated_at');
    expect(database.query.mock.calls[0][1]).toEqual(['previous_month']);
  });
});
