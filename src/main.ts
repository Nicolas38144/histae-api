import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { isUUID } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { AppModule } from './app.module';
import { ApiError } from './common/api-error';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { applicationConfig } from './config/config.service';
import { RateLimitService } from './ratelimit/rate-limit.service';

async function bootstrap(): Promise<void> {
  // Build config before Fastify so trust-proxy and the 1 MiB body cap apply to every route.
  const config = applicationConfig();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({
    trustProxy: config.trustProxy,
    bodyLimit: 1 << 20,
    logger: false,
  }));
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  if (config.openApiEnabled) {
    const document = SwaggerModule.createDocument(app, new DocumentBuilder()
      .setTitle('Histae API')
      .setDescription('API Histae — NestJS avec Fastify')
      .setVersion('3.0.0')
      .addBearerAuth()
      .build());
    SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs-json' });
  }

  const limits = app.get(RateLimitService);
  const logger = new Logger('HTTP');
  const fastify = app.getHttpAdapter().getInstance();
  const requestStarts = new WeakMap<object, bigint>();
  fastify.addHook('onRequest', async (request, reply) => {
    const supplied = request.headers['x-request-id'];
    const requestId = typeof supplied === 'string' && isUUID(supplied, 'all') ? supplied : randomUUID();
    reply.header('X-Request-ID', requestId);
    request.id = requestId;
    requestStarts.set(request, process.hrtime.bigint());
    try {
      await limits.enforce('global', request.ip, config.rateLimit.global, 'rate_limit_exceeded');
    } catch (error) {
      sendHookError(reply, error);
    }
  });
  fastify.addHook('onResponse', async (request, reply) => {
    const startedAt = requestStarts.get(request);
    const durationMs = startedAt ? Number(process.hrtime.bigint() - startedAt) / 1_000_000 : 0;
    const details = `${request.method} ${request.url} ${reply.statusCode} request_id=${request.id} duration_ms=${durationMs.toFixed(1)}`;
    if (reply.statusCode >= 500) logger.error(details);
    else if (reply.statusCode >= 400) logger.warn(details);
    // else logger.debug(details);
  });
  await app.listen(config.port, '0.0.0.0');
  logger.log(`Histae API listening on port ${config.port} (${config.env})`);
}

function sendHookError(reply: { status: (code: number) => { send: (body: unknown) => void }; header: (name: string, value: string) => void }, error: unknown): void {
  if (error instanceof ApiError) {
    if (error.retryAfterSeconds) reply.header('Retry-After', String(error.retryAfterSeconds));
    reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    return;
  }
  reply.status(503).send({ error: { code: 'rate_limit_unavailable', message: 'Request protection is temporarily unavailable.' } });
}

void bootstrap();
