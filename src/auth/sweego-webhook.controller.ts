import { Controller, HttpCode, Post, Req, type RawBodyRequest } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ConfigService } from '../config/config.service';
import { RateLimitService } from '../ratelimit/rate-limit.service';
import { SweegoWebhookService } from './sweego-webhook.service';

@Controller('api/auth/sweego')
export class SweegoWebhookController {
  constructor(private readonly webhooks: SweegoWebhookService, private readonly limits: RateLimitService,
    private readonly config: ConfigService) {}

  @Post('webhook')
  @HttpCode(200)
  async webhook(@Req() request: RawBodyRequest<FastifyRequest>): Promise<{ received: true }> {
    await this.limits.enforce('sms-webhook', request.ip, this.config.rateLimit.smsWebhook, 'sms_webhook_rate_limit_exceeded');
    await this.webhooks.handle(request.rawBody, {
      id: request.headers['webhook-id'], timestamp: request.headers['webhook-timestamp'],
      signature: request.headers['webhook-signature'],
    });
    return { received: true };
  }
}
