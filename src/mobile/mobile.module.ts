import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MobileController } from './mobile.controller';
import { MobileDeliveryService } from './mobile-delivery.service';
import { MobileRepository } from './mobile.repository';
import { MobileService } from './mobile.service';
import { PushService } from './push.service';
import { RealtimeService } from './realtime.service';
import { NotificationPushRepository } from './notification-push.repository';
import { NotificationPushService } from './notification-push.service';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [MobileController],
  providers: [MobileRepository, MobileService, RealtimeService, PushService, MobileDeliveryService,
    NotificationPushRepository, NotificationPushService],
  exports: [MobileDeliveryService, RealtimeService, NotificationPushService],
})
export class MobileModule {}
