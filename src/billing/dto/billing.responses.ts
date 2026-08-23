import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BILLING_PERIODS, STRIPE_SUBSCRIPTION_STATUSES } from '../billing.models';

export class SubscriptionResponseDto {
  @ApiProperty({ enum: ['free', 'premium'] }) plan!: string;
  @ApiPropertyOptional({ enum: ['stripe'], nullable: true }) provider!: string | null;
  @ApiPropertyOptional({ enum: STRIPE_SUBSCRIPTION_STATUSES, nullable: true }) status!: string | null;
  @ApiProperty() access_granted!: boolean;
  @ApiPropertyOptional({ enum: BILLING_PERIODS, nullable: true }) billing_period!: string | null;
  @ApiProperty() cancel_at_period_end!: boolean;
  @ApiPropertyOptional({ format: 'date-time', nullable: true }) current_period_starts_at!: Date | null;
  @ApiPropertyOptional({ format: 'date-time', nullable: true }) current_period_ends_at!: Date | null;
  @ApiPropertyOptional({ format: 'date-time', nullable: true }) trial_ends_at!: Date | null;
  @ApiPropertyOptional({ format: 'date-time', nullable: true }) canceled_at!: Date | null;
  @ApiProperty() customer_portal_available!: boolean;
}

export class CheckoutSessionResponseDto {
  @ApiProperty() session_id!: string;
  @ApiProperty({ format: 'uri' }) url!: string;
  @ApiProperty({ format: 'date-time' }) expires_at!: Date;
}

export class PortalSessionResponseDto {
  @ApiProperty({ format: 'uri' }) url!: string;
}

export class StripeWebhookResponseDto {
  @ApiProperty() received!: boolean;
}
