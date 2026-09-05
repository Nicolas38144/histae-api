import type { FastifyRequest } from 'fastify';

export function requestPath(url: string): string {
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

/** Returns a registered route template, never a user-supplied concrete path. */
export function requestRoute(request: Pick<FastifyRequest, 'routeOptions'>): string {
  const route = request.routeOptions.url;
  return typeof route === 'string' && route.startsWith('/') ? route : '<unmatched>';
}
