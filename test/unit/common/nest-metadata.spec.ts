import 'reflect-metadata';
import { AuthController } from '../../../src/auth/auth.controller';
import { DevelopmentOnlyGuard, JwtActiveGuard } from '../../../src/auth/auth.guard';
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
import { PlansController } from '../../../src/plans/plans.controller';
import { PlansRepository } from '../../../src/plans/plans.repository';
import { PlansService } from '../../../src/plans/plans.service';
import { PrivacyMaintenanceService } from '../../../src/privacy/privacy-maintenance.service';
import { PrivacyController } from '../../../src/privacy/privacy.controller';
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

const injectedClasses = [
  AuthController, JwtActiveGuard, DevelopmentOnlyGuard, AuthRepository, AuthService, OtpService, SweegoSmsService, TokenService,
  DatabaseService, ScyllaService, RedisService, HealthController, RateLimitService,
  DiscoveryController, DiscoveryRepository, DiscoveryStore, DiscoveryService,
  UsersController, UsersRepository, UsersService,
  PlansController, PlansRepository, PlansService,
  MatchesController, MatchesRepository, MatchesService, MatchMaintenanceService,
  PrivacyController, PrivacyRepository, PrivacyService, PrivacyMaintenanceService,
  TraitsController, TraitsRepository, TraitsService,
  ReportsController, ReportsRepository, ReportsService,
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
