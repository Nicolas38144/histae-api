import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingController, StripeWebhookController } from './billing.controller';
import { BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';
import { StripeGateway } from './stripe.gateway';
import { StripeWebhookService } from './stripe-webhook.service';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [BillingController, StripeWebhookController],
  providers: [BillingRepository, StripeGateway, BillingService, StripeWebhookService],
  exports: [BillingService],
})
export class BillingModule {}
