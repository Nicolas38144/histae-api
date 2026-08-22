import { Controller, Delete, Get, Headers, HttpCode, HttpStatus, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ValidatedBody } from '../common/http/validated-request.decorator';
import { ApiBearerAuth, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { JwtActiveGuard, userId } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { AllowIncompleteOnboarding } from '../auth/onboarding.decorator';
import { UsersService } from './users.service';
import type { ConsentChange, PreferencesInput, PresenceInput, ProfileInput } from './users.service';
import { ConfirmAccountDeletionDto, UpdateConsentsDto, UpdatePreferencesDto, UpdatePresenceDto, UpdateProfileDto } from './dto/users.dto';
import type { PublicProfile } from './users.mapper';
import type { ConsentState, PreferencesRow } from './users.models';
import { AccountDeletionTokenResponseDto, ConsentStateResponseDto, PreferencesResponseDto, ProfileResponseDto } from './dto/users.responses';
import { MessageResponseDto } from '../common/dto/responses.dto';

@Controller('api/users/me')
@UseGuards(JwtActiveGuard)
@ApiTags('Users')
@ApiBearerAuth()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOkResponse({ type: ProfileResponseDto })
  getMe(@Req() request: AuthenticatedRequest): Promise<PublicProfile> {
    return this.users.getProfile(userId(request));
  }

  @Get('consents')
  @AllowIncompleteOnboarding()
  @ApiOkResponse({ type: ConsentStateResponseDto })
  getConsents(@Req() request: AuthenticatedRequest): Promise<ConsentState> {
    return this.users.getConsents(userId(request));
  }

  @Put('consents')
  @AllowIncompleteOnboarding()
  @ApiOkResponse({ type: ConsentStateResponseDto })
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
  @ApiOkResponse({ type: MessageResponseDto })
  async updateProfile(
    @ValidatedBody({ code: 'invalid_profile_payload', message: 'The profile request body is invalid.' }) body: UpdateProfileDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ message: string }> {
    const input: ProfileInput = {
      firstname: body.firstname,
      birthdate: body.birthdate,
      sex: body.sex ?? null,
      bio: body.bio ?? null,
      photo: body.photo ?? null,
    };
    await this.users.updateProfile(userId(request), input);
    return { message: 'profile updated' };
  }

  @Get('preferences')
  @ApiOkResponse({ type: PreferencesResponseDto })
  getPreferences(@Req() request: AuthenticatedRequest): Promise<PreferencesRow> {
    return this.users.getPreferences(userId(request));
  }

  @Patch('preferences')
  @ApiOkResponse({ type: MessageResponseDto })
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
  @ApiOkResponse({ type: MessageResponseDto })
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
  @ApiNoContentResponse()
  async deleteAccount(
    @ValidatedBody({ code: 'invalid_account_deletion_payload', message: 'The account deletion request body is invalid.' }) body: ConfirmAccountDeletionDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.users.confirmAnonymize(userId(request), body.confirmation_token);
  }

  @Post('deletion-token')
  @HttpCode(HttpStatus.CREATED)
  @AllowIncompleteOnboarding()
  @ApiCreatedResponse({ type: AccountDeletionTokenResponseDto })
  issueDeletionToken(@Req() request: AuthenticatedRequest): Promise<{ confirmation_token: string; expires_at: Date }> {
    return this.users.issueDeletionToken(userId(request));
  }
}
