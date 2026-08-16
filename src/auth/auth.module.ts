import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '../config/config.service';
import { AuthController } from './auth.controller';
import { AdminGuard, DevelopmentOnlyGuard, JwtActiveGuard } from './auth.guard';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';

@Module({
  imports: [JwtModule.registerAsync({ inject: [ConfigService], useFactory: (config: ConfigService) => ({ secret: config.jwt.secret }) })],
  controllers: [AuthController],
  providers: [AuthRepository, TokenService, OtpService, AuthService, JwtActiveGuard, AdminGuard, DevelopmentOnlyGuard],
  exports: [AuthService, JwtActiveGuard, AdminGuard, DevelopmentOnlyGuard, JwtModule],
})
export class AuthModule {}
