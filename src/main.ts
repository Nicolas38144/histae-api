import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import fastifyMultipart from '@fastify/multipart';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { registerHttpLifecycle } from './common/http/http-lifecycle';
import { applicationConfig } from './config/config.service';
import { RateLimitService } from './ratelimit/rate-limit.service';
import { MAX_PHOTO_UPLOAD_BYTES } from './photos/photo-processor.service';
import { OperationalMetricsService } from './operations/operational-metrics.service';

async function bootstrap(): Promise<void> {
  // Build config before Fastify so trust-proxy and the 1 MiB body cap apply to every route.
  const config = applicationConfig();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({
    trustProxy: config.trustProxy,
    bodyLimit: 1 << 20,
    logger: false,
  }), { rawBody: true });
  await app.register(fastifyMultipart, {
    limits: { fileSize: MAX_PHOTO_UPLOAD_BYTES, files: 1, fields: 0, parts: 1 },
    throwFileSizeLimit: true,
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  if (config.corsOrigins.length) {
    app.enableCors({
      origin: config.corsOrigins,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-ID'],
      exposedHeaders: ['Retry-After', 'X-Request-ID'],
      credentials: false,
      maxAge: 600,
    });
  }
  const limits = app.get(RateLimitService);
  const metrics = app.get(OperationalMetricsService);
  const logger = new Logger('HTTP');
  const fastify = app.getHttpAdapter().getInstance();
  registerHttpLifecycle(fastify, limits, config, metrics, logger);
  await app.listen(config.port, '0.0.0.0');
  logger.log(`Histae API listening on port ${config.port} (${config.env})`);
}

void bootstrap().catch((error: unknown) => {
  const logger = new Logger('Bootstrap');
  if (error instanceof Error) logger.error('Histae API failed to start.', error.stack);
  else logger.error(`Histae API failed to start: ${String(error)}`);
  process.exitCode = 1;
});
