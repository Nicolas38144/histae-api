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

@Module({ imports: [CoreModule, AuthModule, UsersModule, PrivacyModule, TraitsModule, ReportsModule, PlansModule, MatchesModule, DiscoveryModule] })
export class AppModule {}
