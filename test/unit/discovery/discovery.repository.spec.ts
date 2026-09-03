import { DiscoveryRepository } from '../../../src/discovery/discovery.repository';

describe('DiscoveryRepository SQL access path', () => {
  it('filters and paginates candidates before loading their collections', async () => {
    const database = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const repository = new DiscoveryRepository(database as never);

    await repository.candidateBatch(
      '11111111-1111-4111-8111-111111111111',
      'sensitive-v1',
      'location-v1',
      21,
    );

    const sql = String(database.query.mock.calls[0]?.[0]);
    expect(sql).toContain('page AS MATERIALIZED');
    expect(sql.indexOf('LIMIT $6')).toBeLessThan(sql.indexOf('LEFT JOIN LATERAL'));
    expect(sql).toContain('target_presence.latitude BETWEEN');
    expect(sql).not.toContain('target_presence.latitude::double precision BETWEEN');
    expect(sql).toContain('statement_timestamp()');
  });
});
