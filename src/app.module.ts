import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { CoreModule } from './core.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { MatchesModule } from './matches/matches.module';
import { PlansModule } from './plans/plans.module';
import { PrivacyModule } from './privacy/privacy.module';
import { ReportsModule } from './reports/reports.module';
import { TraitsModule } from './traits/traits.module';
import { UsersModule } from './users/users.module';
import { AdminModule } from './admin/admin.module';
import { MobileModule } from './mobile/mobile.module';
import { BillingModule } from './billing/billing.module';
import { ProfileQuestionsModule } from './profile-questions/profile-questions.module';
import { ModerationModule } from './moderation/moderation.module';
import { AdminAuthModule } from './admin-auth/admin-auth.module';
import { ErasureModule } from './privacy/erasure.module';

@Module({ imports: [CoreModule, AuthModule, AdminAuthModule, MobileModule, BillingModule, AdminModule, ModerationModule, UsersModule, PrivacyModule, ErasureModule, TraitsModule, ProfileQuestionsModule, ReportsModule, PlansModule, MatchesModule, DiscoveryModule] })
export class AppModule {}
