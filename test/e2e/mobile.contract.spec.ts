import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { JwtActiveGuard } from '../../src/auth/auth.guard';
import type { AuthenticatedRequest } from '../../src/auth/auth.types';
import { ApiExceptionFilter } from '../../src/common/api-exception.filter';
import { MobileController } from '../../src/mobile/mobile.controller';
import { MobileService } from '../../src/mobile/mobile.service';
import { RealtimeService } from '../../src/mobile/realtime.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';

describe('Mobile HTTP contract', () => {
  let app: NestFastifyApplication;
  const device = {
    id: DEVICE_ID,
    platform: 'android',
    app_version: '1.0.0',
    created_at: new Date('2030-01-01T00:00:00.000Z'),
    last_used_at: new Date('2030-01-01T00:00:00.000Z'),
  };
  const mobile = {
    registerDevice: jest.fn().mockResolvedValue(device),
    listDevices: jest.fn().mockResolvedValue([device]),
    removeDevice: jest.fn().mockResolvedValue(undefined),
  };
  const activeGuard: CanActivate = {
    canActivate(context: ExecutionContext): boolean {
      const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
      request.auth = {
        userId: USER_ID,
        account: { user_id: USER_ID, role: 'user', is_banned: false, onboarding_complete: true },
      };
      return true;
    },
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MobileController],
      providers: [
        { provide: MobileService, useValue: mobile },
        { provide: RealtimeService, useValue: { stream: jest.fn() } },
      ],
    }).overrideGuard(JwtActiveGuard).useValue(activeGuard).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
  });

  afterAll(async () => app?.close());

  beforeEach(() => jest.clearAllMocks());

  it('registers a validated device without returning its provider token', async () => {
    const token = 'fcm-provider-token-with-enough-characters';
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/api/users/me/devices',
      payload: { push_token: token, platform: 'android', app_version: '1.0.0' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      ...device,
      created_at: '2030-01-01T00:00:00.000Z',
      last_used_at: '2030-01-01T00:00:00.000Z',
    });
    expect(response.json()).not.toHaveProperty('push_token');
    expect(mobile.registerDevice).toHaveBeenCalledWith(USER_ID, token, 'android', '1.0.0');
  });

  it('lists and removes only devices belonging to the authenticated user', async () => {
    const list = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/api/users/me/devices' });
    const removal = await app.getHttpAdapter().getInstance().inject({ method: 'DELETE', url: `/api/users/me/devices/${DEVICE_ID}` });

    expect(list.statusCode).toBe(200);
    expect(list.json().devices).toHaveLength(1);
    expect(removal.statusCode).toBe(204);
    expect(mobile.listDevices).toHaveBeenCalledWith(USER_ID);
    expect(mobile.removeDevice).toHaveBeenCalledWith(USER_ID, DEVICE_ID);
  });

  it('rejects invalid device registrations before reaching the service', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url: '/api/users/me/devices',
      payload: { push_token: 'short', platform: 'web' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: {
      code: 'invalid_device_payload',
      message: 'The device registration request body is invalid.',
    } });
    expect(mobile.registerDevice).not.toHaveBeenCalled();
  });
});
