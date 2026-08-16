import { parseEnvironment } from '../../../src/config/config.service';

describe('parseEnvironment', () => {
  it.each(['development', 'test', 'production'] as const)('accepts %s', (value) => {
    expect(parseEnvironment(value)).toBe(value);
  });

  it.each([undefined, '', 'staging', 'developmentish'])('fails closed for %p', (value) => {
    expect(() => parseEnvironment(value)).toThrow('config: ENV must be development, test, or production');
  });
});
