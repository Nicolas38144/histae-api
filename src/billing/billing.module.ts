import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingController, StripeWebhookController } from './billing.controller';
import { BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';
import { StripeGateway } from './stripe.gateway';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [BillingController, StripeWebhookController],
  providers: [BillingRepository, StripeGateway, BillingService],
  exports: [BillingService],
})
export class BillingModule {}
