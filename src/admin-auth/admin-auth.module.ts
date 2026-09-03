import { Global, Module } from '@nestjs/common';
import { AdminAuthController } from './admin-auth.controller';
import { AdminSessionGuard, RecentAdminAuthenticationGuard } from './admin-auth.guard';
import { AdminAuthRepository } from './admin-auth.repository';
import { AdminAuthService } from './admin-auth.service';

@Global()
@Module({
  controllers: [AdminAuthController],
  providers: [AdminAuthRepository, AdminAuthService, AdminSessionGuard, RecentAdminAuthenticationGuard],
  exports: [AdminAuthService, AdminSessionGuard, RecentAdminAuthenticationGuard],
})
export class AdminAuthModule {}
