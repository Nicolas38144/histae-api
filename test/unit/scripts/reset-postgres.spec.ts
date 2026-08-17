import { assertResetAllowed } from '../../../scripts/reset';

const validTarget = {
  environment: 'development',
  database: 'histae-dev',
  host: '127.0.0.1',
  confirmation: 'RESET',
};

describe('PostgreSQL reset safety', () => {
  it('allows only the confirmed local development database', () => {
    expect(() => assertResetAllowed(validTarget)).not.toThrow();
  });

  it('rejects every unsafe target before connecting', () => {
    const unsafeTargets = [
      { ...validTarget, confirmation: undefined },
      { ...validTarget, environment: 'test' },
      { ...validTarget, environment: 'production' },
      { ...validTarget, database: 'histae-production' },
      { ...validTarget, host: 'postgres.example.com' },
    ];
    for (const target of unsafeTargets) {
      expect(() => assertResetAllowed(target)).toThrow();
    }
  });
});
