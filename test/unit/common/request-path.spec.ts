import { requestPath, requestRoute } from '../../../src/common/http/request-path';

describe('requestPath', () => {
  it('keeps a route without a query string unchanged', () => {
    expect(requestPath('/api/users/me')).toBe('/api/users/me');
  });

  it('removes sensitive query parameters from the loggable path', () => {
    expect(requestPath('/api/admin/users?search=%2B33600000000&reason=investigation')).toBe('/api/admin/users');
  });

  it('uses only the registered route template for operational logs', () => {
    expect(requestRoute({ routeOptions: { url: '/api/admin/users/:userId' } } as never))
      .toBe('/api/admin/users/:userId');
    expect(requestRoute({ routeOptions: { url: undefined } } as never)).toBe('<unmatched>');
  });
});
