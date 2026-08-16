import { UsersRepository } from '../../../src/users/users.repository';

describe('UsersRepository legal-choice ordering', () => {
  it('keeps timestamps in PostgreSQL and orders current state by the database sequence', async () => {
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ user_id: 'user-id' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 }) };
    const database = {
      transaction: jest.fn(async (work: (transactionClient: typeof client) => Promise<boolean>) => work(client)),
      query: jest.fn().mockResolvedValue({ rows: [] }),
    };
    const repository = new UsersRepository(database as never);

    await expect(repository.recordConsents('user-id', [{
      consent_type: 'terms_of_service_acceptance', granted: true, document_version: 'terms-v1',
    }], '127.0.0.1', 'test-agent')).resolves.toBe(true);

    expect(client.query.mock.calls[2]?.[0]).toContain('withdrawn_at = clock_timestamp()');
    expect(client.query.mock.calls[3]?.[0]).toContain('clock_timestamp()');
    expect(client.query.mock.calls[3]?.[1]).not.toEqual(expect.arrayContaining([expect.any(Date)]));

    await repository.currentConsents('user-id');
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining('event_sequence DESC'), ['user-id']);
  });

  it('does not append a duplicate event when a mobile retry repeats the current choice', async () => {
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ user_id: 'user-id' }] })
      .mockResolvedValueOnce({ rows: [{ granted: true, document_version: 'terms-v1' }] }) };
    const database = {
      transaction: jest.fn(async (work: (transactionClient: typeof client) => Promise<boolean>) => work(client)),
    };
    const repository = new UsersRepository(database as never);

    await expect(repository.recordConsents('user-id', [{
      consent_type: 'terms_of_service_acceptance', granted: true, document_version: 'terms-v1',
    }], '127.0.0.1', 'test-agent')).resolves.toBe(true);
    expect(client.query).toHaveBeenCalledTimes(2);
  });
});
