import { requestPath } from '../../../src/common/http/request-path';

describe('requestPath', () => {
  it('keeps a route without a query string unchanged', () => {
    expect(requestPath('/api/users/me')).toBe('/api/users/me');
  });

  it('removes sensitive query parameters from the loggable path', () => {
    expect(requestPath('/api/admin/users?search=%2B33600000000&reason=investigation')).toBe('/api/admin/users');
  });
});
