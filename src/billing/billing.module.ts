import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingController, StripeWebhookController } from './billing.controller';
import { BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';
import { StripeGateway } from './stripe.gateway';
import { StripeWebhookService } from './stripe-webhook.service';
import { BillingReconciliationController } from './billing-reconciliation.controller';
import { BillingReconciliationRepository } from './billing-reconciliation.repository';
import { BillingReconciliationService } from './billing-reconciliation.service';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [BillingController, StripeWebhookController, BillingReconciliationController],
  providers: [
    BillingRepository,
    BillingReconciliationRepository,
    StripeGateway,
    BillingService,
    StripeWebhookService,
    BillingReconciliationService,
  ],
  exports: [BillingService, BillingReconciliationService],
})
export class BillingModule {}
