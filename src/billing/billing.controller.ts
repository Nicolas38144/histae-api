import type { RawBodyRequest } from '@nestjs/common';
import { Controller, Get, Headers, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { JwtActiveGuard, userId } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { ValidatedBody } from '../common/http/validated-request.decorator';
import { ConfigService } from '../config/config.service';
import { RateLimitService } from '../ratelimit/rate-limit.service';
import type { CheckoutSessionView, SubscriptionView } from './billing.models';
import { BillingService } from './billing.service';
import { CreateCheckoutDto } from './dto/billing.dto';
import { StripeWebhookService } from './stripe-webhook.service';

@Controller('api/users/me/subscription')
@UseGuards(JwtActiveGuard)

export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly limits: RateLimitService,
    private readonly config: ConfigService,
  ) {}

  @Get()

  subscription(@Req() request: AuthenticatedRequest): Promise<SubscriptionView> {
    return this.billing.subscription(userId(request));
  }

  @Post('checkout')
  @HttpCode(HttpStatus.CREATED)

  async checkout(
    @ValidatedBody({ code: 'invalid_checkout_payload', message: 'The Checkout request body is invalid.' }) body: CreateCheckoutDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ): Promise<CheckoutSessionView> {
    await this.limits.enforce('billing', userId(request), this.config.rateLimit.billing, 'billing_rate_limit_exceeded');
    return this.billing.createCheckout(userId(request), body.billing_period, idempotencyKey);
  }

  @Post('portal')

  async portal(@Req() request: AuthenticatedRequest): Promise<{ url: string }> {
    await this.limits.enforce('billing', userId(request), this.config.rateLimit.billing, 'billing_rate_limit_exceeded');
    return this.billing.createPortal(userId(request));
  }
}

@Controller('api/billing/stripe')

export class StripeWebhookController {
  constructor(
    private readonly webhooks: StripeWebhookService,
    private readonly limits: RateLimitService,
    private readonly config: ConfigService,
  ) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)

  async webhook(
    @Headers('stripe-signature') signature: string | undefined,
    @Req() request: RawBodyRequest<FastifyRequest>,
  ): Promise<{ received: true }> {
    await this.limits.enforce(
      'billing-webhook',
      request.ip,
      this.config.rateLimit.billingWebhook,
      'billing_webhook_rate_limit_exceeded',
    );
    await this.webhooks.handle(request.rawBody, signature);
    return { received: true };
  }
}
