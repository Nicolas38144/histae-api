import { Module } from '@nestjs/common';
import appConfig, { validationSchema } from './config/app.config';
import { ConfigModule } from '@nestjs/config';

import { DatabaseModule } from './database/database.module';

import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { ProfilesModule } from './profiles/profiles.module';
import { PreferencesModule } from './preferences/preferences.module';
import { PresenceModule } from './presence/presence.module';
import { TraitsModule } from './traits/traits.module';
import { SwipesModule } from './swipes/swipes.module';
import { MatchesModule } from './matches/matches.module';
import { MessagesModule } from './messages/messages.module';
import { RecommendationsModule } from './recommendations/recommendations.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      validationSchema,
      envFilePath: [
        `.env.${process.env.NODE_ENV}`,
        '.env',
      ],
    }),
    DatabaseModule,
    AuthModule,
    UsersModule,
    ProfilesModule,
    PreferencesModule,
    PresenceModule,
    TraitsModule,
    SwipesModule,
    MatchesModule,
    MessagesModule,
    RecommendationsModule,
    SubscriptionsModule,
  ],
})
export class AppModule {}
