import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MobileController } from './mobile.controller';
import { MobileDeliveryService } from './mobile-delivery.service';
import { MobileRepository } from './mobile.repository';
import { MobileService } from './mobile.service';
import { PushService } from './push.service';
import { RealtimeService } from './realtime.service';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [MobileController],
  providers: [MobileRepository, MobileService, RealtimeService, PushService, MobileDeliveryService],
  exports: [MobileDeliveryService, RealtimeService],
})
export class MobileModule {}
