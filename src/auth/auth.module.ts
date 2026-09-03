import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '../config/config.service';
import { AuthController } from './auth.controller';
import { JwtActiveGuard } from './auth.guard';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { SmsDelivery } from './sms-delivery';
import { SweegoSmsService } from './sweego-sms.service';
import { TokenService } from './token.service';

@Module({
  imports: [JwtModule.registerAsync({ inject: [ConfigService], useFactory: (config: ConfigService) => ({ secret: config.jwt.secret }) })],
  controllers: [AuthController],
  providers: [AuthRepository, TokenService, { provide: SmsDelivery, useClass: SweegoSmsService }, OtpService, AuthService, JwtActiveGuard],
  exports: [AuthService, JwtActiveGuard, JwtModule],
})
export class AuthModule {}
