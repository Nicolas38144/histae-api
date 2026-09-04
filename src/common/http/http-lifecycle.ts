import { Logger } from '@nestjs/common';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isUUID } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../api-error';
import type { ConfigService } from '../../config/config.service';
import type { RateLimitService } from '../../ratelimit/rate-limit.service';
import type { OperationalMetricsService } from '../../operations/operational-metrics.service';
import { requestPath } from './request-path';

type HttpRuntimeConfig = Pick<ConfigService, 'env' | 'rateLimit'>;

export function registerHttpLifecycle(
  fastify: FastifyInstance,
  limits: RateLimitService,
  config: HttpRuntimeConfig,
  metrics?: OperationalMetricsService,
  logger = new Logger('HTTP'),
): void {
  const requestStarts = new WeakMap<FastifyRequest, bigint>();

  fastify.addHook('onRequest', async (request, reply) => {
    applySecurityHeaders(reply, config.env);
    const suppliedRequestId = request.headers['x-request-id'];
    const requestId = typeof suppliedRequestId === 'string' && isUUID(suppliedRequestId, '4')
      ? suppliedRequestId.toLowerCase()
      : randomUUID();
    reply.header('X-Request-ID', requestId);
    request.id = requestId;
    requestStarts.set(request, process.hrtime.bigint());

    if (['/api/billing/stripe/webhook', '/api/auth/sweego/webhook'].includes(requestPath(request.url))) return;
    try {
      await limits.enforce('global', request.ip, config.rateLimit.global, 'rate_limit_exceeded');
    } catch (error) {
      return sendRateLimitError(reply, error);
    }
  });

  fastify.addHook('onResponse', async (request, reply) => {
    const startedAt = requestStarts.get(request);
    const durationMs = startedAt ? Number(process.hrtime.bigint() - startedAt) / 1_000_000 : 0;
    metrics?.recordHttp(
      request.method,
      request.routeOptions.url ?? '<unmatched>',
      reply.statusCode,
      durationMs,
    );
    const details = `${request.method} ${requestPath(request.url)} ${reply.statusCode} request_id=${request.id} duration_ms=${durationMs.toFixed(1)}`;
    if (reply.statusCode >= 500) logger.error(details);
    else if (reply.statusCode >= 400) logger.warn(details);
  });
}

export function applySecurityHeaders(reply: FastifyReply, environment: ConfigService['env']): void {
  reply.header('Cache-Control', 'no-store');
  reply.header('Content-Security-Policy', "base-uri 'none'; frame-ancestors 'none'; object-src 'none'");
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-DNS-Prefetch-Control', 'off');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('X-Permitted-Cross-Domain-Policies', 'none');
  if (environment === 'production') {
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function sendRateLimitError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ApiError) {
    if (error.retryAfterSeconds) reply.header('Retry-After', String(error.retryAfterSeconds));
    return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
  }
  return reply.status(503).send({
    error: { code: 'rate_limit_unavailable', message: 'Request protection is temporarily unavailable.' },
  });
}
