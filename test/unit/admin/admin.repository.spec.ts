import { AdminRepository } from '../../../src/admin/admin.repository';

describe('AdminRepository SQL access path', () => {
  it('binds an exact UUID search without casting the indexed account column', async () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const database = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const repository = new AdminRepository(database as never, {} as never);

    await repository.listUsers(
      undefined,
      undefined,
      userId,
      21,
      0,
      undefined,
      'terms-v1',
      'privacy-v1',
    );

    const [sql, values] = database.query.mock.calls[0]!;
    expect(sql).toContain('account.user_id = $10::uuid');
    expect(sql).not.toContain('account.user_id::text');
    expect(values[9]).toBe(userId);
  });
});

describe('AdminRepository account safety', () => {
  it('prevents an administrator from banning another administrator', async () => {
    const client = { query: jest.fn().mockResolvedValueOnce({ rows: [{ role: 'admin' }] }) };
    const database = { transaction: jest.fn((callback) => callback(client)) };
    const repository = new AdminRepository(database as never, {} as never);

    await expect(repository.setUserBan('target', true, 'reason', 'actor', 'admin')).resolves.toBe('forbidden');
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('revokes refresh tokens and records an audit event when banning a user', async () => {
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ role: 'user' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 2 })
      .mockResolvedValue({ rowCount: 1 }) };
    const database = { transaction: jest.fn((callback) => callback(client)) };
    const repository = new AdminRepository(database as never, {} as never);

    await expect(repository.setUserBan('target', true, 'Safety incident', 'actor', 'admin')).resolves.toBe('updated');
    expect(client.query.mock.calls[2][0]).toContain('UPDATE refresh_token_family');
    expect(client.query.mock.calls[3][0]).toContain('UPDATE refresh_tokens SET revoked = true');
    expect(client.query.mock.calls[4][0]).toContain('DELETE FROM device_token');
    expect(client.query.mock.calls[5][0]).toContain('data_access_log');
    expect(client.query.mock.calls[5][1]).toContain('admin_ban');
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
    const repository = new AdminRepository(database as never, {} as never);

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

describe('AdminRepository photo reconciliation', () => {
  it('moves a stale photo to deleting, requeues its event and audits the action', async () => {
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{
        user_id: 'user',
        status: 'processing',
        updated_at: new Date('2030-01-01T00:00:00.000Z'),
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 }) };
    const database = { transaction: jest.fn((callback) => callback(client)) };
    const outbox = { requeue: jest.fn().mockResolvedValue(undefined) };
    const repository = new AdminRepository(database as never, outbox as never);

    await expect(repository.reconcilePhoto(
      'photo',
      new Date('2030-01-01T00:30:00.000Z'),
      new Date('2030-01-01T00:55:00.000Z'),
      'admin',
      'admin',
      'Relance opérateur',
    )).resolves.toBe('queued');

    expect(client.query.mock.calls[2][0]).toContain("SET status = 'deleting'");
    expect(outbox.requeue).toHaveBeenCalledWith(client, {
      eventType: 'photo.delete',
      aggregateId: 'photo',
    });
    expect(client.query.mock.calls[3][1]).toEqual([
      'user', 'admin', 'admin', 'admin_reconcile_photo', 'Relance opérateur',
    ]);
  });

  it('does not requeue an event owned by a live worker', async () => {
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{
        user_id: 'user',
        status: 'deleting',
        updated_at: new Date('2030-01-01T00:00:00.000Z'),
      }] })
      .mockResolvedValueOnce({ rows: [{
        status: 'processing',
        locked_at: new Date('2030-01-01T00:59:00.000Z'),
      }] }) };
    const database = { transaction: jest.fn((callback) => callback(client)) };
    const outbox = { requeue: jest.fn() };
    const repository = new AdminRepository(database as never, outbox as never);

    await expect(repository.reconcilePhoto(
      'photo',
      new Date('2030-01-01T00:30:00.000Z'),
      new Date('2030-01-01T00:55:00.000Z'),
      'admin',
      'admin',
      'Relance opérateur',
    )).resolves.toBe('already_processing');
    expect(outbox.requeue).not.toHaveBeenCalled();
  });
});
