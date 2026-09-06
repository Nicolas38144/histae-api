import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { formatLogEvent } from '../common/logging/safe-logging';
import { ConfigService } from '../config/config.service';
import { PrometheusExporterService } from './prometheus-exporter.service';

const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

@Injectable()
export class MetricsServerService implements OnModuleDestroy {
  private readonly logger = new Logger(MetricsServerService.name);
  private server: Server | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly exporter: PrometheusExporterService,
  ) {}

  async start(): Promise<number | null> {
    if (!this.config.metrics.enabled) return null;
    if (this.server) throw new Error('metrics server has already been started');
    const server = createServer(async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      if (request.url !== '/metrics') {
        response.writeHead(404).end('Not Found\n');
        return;
      }
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        response.writeHead(405).end('Method Not Allowed\n');
        return;
      }
      if (!validBearerToken(request.headers.authorization, this.config.metrics.token)) {
        response.setHeader('WWW-Authenticate', 'Bearer');
        response.writeHead(401).end('Unauthorized\n');
        return;
      }
      try {
        response.writeHead(200, { 'Content-Type': PROMETHEUS_CONTENT_TYPE });
        response.end(await this.exporter.render());
      } catch {
        response.writeHead(503).end('Metrics unavailable\n');
      }
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 5_000;
    server.maxRequestsPerSocket = 100;
    this.server = server;
    const port = await listen(server, this.config.metrics.port, this.config.metrics.host);
    this.logger.log(formatLogEvent('metrics_server_started', { port }));
    return port;
  }

  async onModuleDestroy(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server?.listening) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function validBearerToken(authorization: string | undefined, expected: string): boolean {
  if (!authorization?.startsWith('Bearer ')) return false;
  const actualBuffer = Buffer.from(authorization.slice('Bearer '.length));
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    });
  });
}
