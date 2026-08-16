import { assertResetAllowed } from '../../../scripts/reset-scylla';

const validTarget = {
  environment: 'development',
  enabled: true,
  keyspace: 'histae_discovery',
  contactPoints: ['127.0.0.1'],
  confirmation: 'RESET_SCYLLA_DATA',
};

describe('ScyllaDB reset safety', () => {
  it('allows only the confirmed local development keyspace', () => {
    expect(() => assertResetAllowed(validTarget)).not.toThrow();
  });

  it('rejects every unsafe target before connecting', () => {
    const unsafeTargets = [
      { ...validTarget, confirmation: undefined },
      { ...validTarget, environment: 'production' },
      { ...validTarget, enabled: false },
      { ...validTarget, keyspace: 'production_discovery' },
      { ...validTarget, contactPoints: ['scylla.example.com'] },
      { ...validTarget, contactPoints: [] },
    ];
    for (const target of unsafeTargets) {
      expect(() => assertResetAllowed(target)).toThrow();
    }
  });
});
