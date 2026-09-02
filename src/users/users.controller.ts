import { Controller, Delete, Get, Headers, HttpCode, HttpStatus, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ValidatedBody } from '../common/http/validated-request.decorator';
import { JwtActiveGuard, userId } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { AllowIncompleteOnboarding } from '../auth/onboarding.decorator';
import { UsersService } from './users.service';
import type { ConsentChange, PreferencesInput, PresenceInput, ProfileInput } from './users.service';
import { ConfirmAccountDeletionDto, UpdateConsentsDto, UpdatePreferencesDto, UpdatePresenceDto, UpdateProfileDto } from './dto/users.dto';
import type { PublicProfile } from './users.mapper';
import type { ConsentState, PreferencesRow } from './users.models';
import { apiError } from '../common/api-error';
import { normalizeIdempotencyKey } from '../common/idempotency';
import { MAX_PHOTO_UPLOAD_BYTES } from '../photos/photo-processor.service';
import { RateLimitService } from '../ratelimit/rate-limit.service';
import { ConfigService } from '../config/config.service';

@Controller('api/users/me')
@UseGuards(JwtActiveGuard)

export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly limits: RateLimitService,
    private readonly config: ConfigService,
  ) {}

  @Get()

  getMe(@Req() request: AuthenticatedRequest): Promise<PublicProfile> {
    return this.users.getProfile(userId(request));
  }

  @Get('consents')
  @AllowIncompleteOnboarding()

  getConsents(@Req() request: AuthenticatedRequest): Promise<ConsentState> {
    return this.users.getConsents(userId(request));
  }

  @Put('consents')
  @AllowIncompleteOnboarding()

  async updateConsents(
    @ValidatedBody({ code: 'invalid_consent_payload', message: 'The consent request body is invalid.' }) body: UpdateConsentsDto,
    @Headers('user-agent') userAgent: string | undefined,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConsentState> {
    const changes: ConsentChange[] = body.consents.map((consent) => ({
      consent_type: consent.consent_type,
      granted: consent.granted,
    }));
    return this.users.updateConsents(userId(request), changes, request.ip, userAgent);
  }

  @Patch('profile')

  async updateProfile(
    @ValidatedBody({ code: 'invalid_profile_payload', message: 'The profile request body is invalid.' }) body: UpdateProfileDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ message: string }> {
    const input: ProfileInput = {
      firstname: body.firstname,
      birthdate: body.birthdate,
      sex: body.sex ?? null,
      bio: body.bio ?? null,
    };
    await this.users.updateProfile(userId(request), input);
    return { message: 'profile updated' };
  }

  @Put('photo')

  async uploadPhoto(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ message: string; photo: string }> {
    const normalizedIdempotencyKey = normalizeIdempotencyKey(idempotencyKey);
    if (!request.isMultipart()) throw apiError(400, 'invalid_photo', 'A multipart photo file is required.');
    await this.limits.enforce('photo', userId(request), this.config.rateLimit.photo, 'photo_rate_limit_exceeded');
    try {
      const part = await request.file({ limits: { fileSize: MAX_PHOTO_UPLOAD_BYTES, files: 1, fields: 0, parts: 1 } });
      if (!part || part.fieldname !== 'photo' || !part.filename) {
        throw apiError(400, 'invalid_photo', 'A single photo file in the photo field is required.');
      }
      const photo = await this.users.uploadPhoto(userId(request), {
        filename: part.filename,
        mimetype: part.mimetype,
        body: await part.toBuffer(),
      }, normalizedIdempotencyKey);
      return { message: 'photo updated', photo };
    } catch (error) {
      if (isMultipartLimitError(error)) {
        if (multipartErrorCode(error) === 'FST_REQ_FILE_TOO_LARGE') {
          throw apiError(413, 'photo_too_large', 'The photo exceeds the allowed size.');
        }
        throw apiError(400, 'invalid_photo', 'A single photo file in the photo field is required.');
      }
      throw error;
    }
  }

  @Delete('photo')
  @HttpCode(HttpStatus.NO_CONTENT)

  async deletePhoto(@Req() request: AuthenticatedRequest): Promise<void> {
    await this.users.deletePhoto(userId(request));
  }

  @Get('preferences')

  getPreferences(@Req() request: AuthenticatedRequest): Promise<PreferencesRow> {
    return this.users.getPreferences(userId(request));
  }

  @Patch('preferences')

  async updatePreferences(
    @ValidatedBody({ code: 'invalid_preferences_payload', message: 'The preferences request body is invalid.' }) body: UpdatePreferencesDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ message: string }> {
    const input: PreferencesInput = {
      min_age: body.min_age,
      max_age: body.max_age,
      max_distance_km: body.max_distance_km,
      looking_for: body.looking_for,
    };
    await this.users.updatePreferences(userId(request), input);
    return { message: 'preferences updated' };
  }

  @Patch('presence')

  async updatePresence(
    @ValidatedBody({ code: 'invalid_presence_payload', message: 'The location request body is invalid.' }) body: UpdatePresenceDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ message: string }> {
    const input: PresenceInput = {
      latitude: body.latitude,
      longitude: body.longitude,
    };
    await this.users.updatePresence(userId(request), input);
    return { message: 'presence updated' };
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @AllowIncompleteOnboarding()

  async deleteAccount(
    @ValidatedBody({ code: 'invalid_account_deletion_payload', message: 'The account deletion request body is invalid.' }) body: ConfirmAccountDeletionDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.users.confirmAnonymize(userId(request), body.confirmation_token);
  }

  @Post('deletion-token')
  @HttpCode(HttpStatus.CREATED)
  @AllowIncompleteOnboarding()

  issueDeletionToken(@Req() request: AuthenticatedRequest): Promise<{ confirmation_token: string; expires_at: Date }> {
    return this.users.issueDeletionToken(userId(request));
  }
}

function multipartErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function isMultipartLimitError(error: unknown): boolean {
  return ['FST_REQ_FILE_TOO_LARGE', 'FST_FILES_LIMIT', 'FST_FIELDS_LIMIT', 'FST_PARTS_LIMIT']
    .includes(multipartErrorCode(error) ?? '');
}
