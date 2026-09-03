import 'reflect-metadata';
import { AuthController } from '../../../src/auth/auth.controller';
import { AdminAuthController } from '../../../src/admin-auth/admin-auth.controller';
import { AdminSessionGuard, RecentAdminAuthenticationGuard } from '../../../src/admin-auth/admin-auth.guard';
import { AdminAuthRepository } from '../../../src/admin-auth/admin-auth.repository';
import { AdminAuthService } from '../../../src/admin-auth/admin-auth.service';
import { JwtActiveGuard } from '../../../src/auth/auth.guard';
import { AuthRepository } from '../../../src/auth/auth.repository';
import { AuthService } from '../../../src/auth/auth.service';
import { OtpService } from '../../../src/auth/otp.service';
import { SweegoSmsService } from '../../../src/auth/sweego-sms.service';
import { TokenService } from '../../../src/auth/token.service';
import { DatabaseService } from '../../../src/database/database.service';
import { DiscoveryController } from '../../../src/discovery/discovery.controller';
import { DiscoveryRepository } from '../../../src/discovery/discovery.repository';
import { DiscoveryService } from '../../../src/discovery/discovery.service';
import { DiscoveryStore } from '../../../src/discovery/discovery.store';
import { HealthController } from '../../../src/health.controller';
import { MatchMaintenanceService } from '../../../src/matches/match-maintenance.service';
import { MatchesController } from '../../../src/matches/matches.controller';
import { MatchesRepository } from '../../../src/matches/matches.repository';
import { MatchesService } from '../../../src/matches/matches.service';
import { MobileController } from '../../../src/mobile/mobile.controller';
import { MobileDeliveryService } from '../../../src/mobile/mobile-delivery.service';
import { MobileRepository } from '../../../src/mobile/mobile.repository';
import { MobileService } from '../../../src/mobile/mobile.service';
import { PushService } from '../../../src/mobile/push.service';
import { RealtimeService } from '../../../src/mobile/realtime.service';
import { PlansController } from '../../../src/plans/plans.controller';
import { PlansRepository } from '../../../src/plans/plans.repository';
import { PlansService } from '../../../src/plans/plans.service';
import { PrivacyMaintenanceService } from '../../../src/privacy/privacy-maintenance.service';
import { AdminPrivacyController, PrivacyController } from '../../../src/privacy/privacy.controller';
import { PrivacyRepository } from '../../../src/privacy/privacy.repository';
import { PrivacyService } from '../../../src/privacy/privacy.service';
import { RateLimitService } from '../../../src/ratelimit/rate-limit.service';
import { ReportsController } from '../../../src/reports/reports.controller';
import { ReportsRepository } from '../../../src/reports/reports.repository';
import { ReportsService } from '../../../src/reports/reports.service';
import { ScyllaService } from '../../../src/scylla/scylla.service';
import { RedisService } from '../../../src/redis/redis.service';
import { TraitsController } from '../../../src/traits/traits.controller';
import { TraitsRepository } from '../../../src/traits/traits.repository';
import { TraitsService } from '../../../src/traits/traits.service';
import { UsersController } from '../../../src/users/users.controller';
import { UsersRepository } from '../../../src/users/users.repository';
import { UsersService } from '../../../src/users/users.service';
import { AdminController } from '../../../src/admin/admin.controller';
import { AdminRepository } from '../../../src/admin/admin.repository';
import { AdminService } from '../../../src/admin/admin.service';
import { BillingController, StripeWebhookController } from '../../../src/billing/billing.controller';
import { BillingRepository } from '../../../src/billing/billing.repository';
import { BillingService } from '../../../src/billing/billing.service';
import { StripeGateway } from '../../../src/billing/stripe.gateway';
import { ObjectStorageService } from '../../../src/storage/object-storage.service';
import { PhotosRepository } from '../../../src/photos/photos.repository';
import { PhotosService } from '../../../src/photos/photos.service';
import { PhotosMaintenanceService } from '../../../src/photos/photos-maintenance.service';
import { OutboxRepository } from '../../../src/outbox/outbox.repository';
import { OutboxWorkerService } from '../../../src/outbox/outbox-worker.service';
import { ProfileQuestionsController } from '../../../src/profile-questions/profile-questions.controller';
import { ProfileQuestionsRepository } from '../../../src/profile-questions/profile-questions.repository';
import { ProfileQuestionsService } from '../../../src/profile-questions/profile-questions.service';
import { ModerationController } from '../../../src/moderation/moderation.controller';
import { ModerationRepository } from '../../../src/moderation/moderation.repository';
import { ModerationService } from '../../../src/moderation/moderation.service';
import { PhotoModerationService } from '../../../src/moderation/photo-moderation.service';
import { OutboxAdminController } from '../../../src/outbox/outbox-admin.controller';
import { OutboxAdminService } from '../../../src/outbox/outbox-admin.service';
import { MaintenanceStatusRepository } from '../../../src/operations/maintenance-status.repository';
import { MaintenanceTrackerService } from '../../../src/operations/maintenance-tracker.service';
import { OperationalStatusService } from '../../../src/operations/operational-status.service';

const injectedClasses = [
  AuthController, JwtActiveGuard, AuthRepository, AuthService, OtpService, SweegoSmsService, TokenService,
  DatabaseService, ScyllaService, RedisService, ObjectStorageService, HealthController, RateLimitService,
  PhotosRepository, PhotosService, PhotosMaintenanceService,
  OutboxRepository, OutboxWorkerService,
  OutboxAdminController, OutboxAdminService,
  MaintenanceStatusRepository, MaintenanceTrackerService, OperationalStatusService,
  DiscoveryController, DiscoveryRepository, DiscoveryStore, DiscoveryService,
  UsersController, UsersRepository, UsersService,
  PlansController, PlansRepository, PlansService,
  MatchesController, MatchesRepository, MatchesService, MatchMaintenanceService,
  MobileController, MobileRepository, MobileService, RealtimeService, PushService, MobileDeliveryService,
  PrivacyController, PrivacyRepository, PrivacyService, PrivacyMaintenanceService,
  AdminPrivacyController,
  TraitsController, TraitsRepository, TraitsService,
  ProfileQuestionsController, ProfileQuestionsRepository, ProfileQuestionsService,
  ModerationController, ModerationRepository, ModerationService, PhotoModerationService,
  ReportsController, ReportsRepository, ReportsService,
  AdminController, AdminRepository, AdminService,
  AdminAuthController, AdminSessionGuard, RecentAdminAuthenticationGuard, AdminAuthRepository, AdminAuthService,
  BillingController, StripeWebhookController, BillingRepository, BillingService, StripeGateway,
];


describe('Nest dependency metadata', () => {
  it.each(injectedClasses)('%p keeps runtime constructor tokens', (target) => {
    const dependencies = Reflect.getMetadata('design:paramtypes', target) as unknown[] | undefined;
    expect(dependencies?.length).toBeGreaterThan(0);
    expect(dependencies).not.toContain(Function);
    expect(dependencies).not.toContain(Object);
    expect(dependencies).not.toContain(undefined);
  });
});
