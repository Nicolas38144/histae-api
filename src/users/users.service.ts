import { Injectable } from '@nestjs/common';
import { apiError } from '../common/api-error';
import { ConfigService } from '../config/config.service';
import { DiscoveryStore } from '../discovery/discovery.store';
import { ScyllaUnavailableError } from '../scylla/scylla.service';
import type { PublicProfile} from './users.mapper';
import { toPublicProfile } from './users.mapper';
import type {
  ConsentChange,
  ConsentState,
  ConsentType,
  PreferencesInput,
  PreferencesRow,
  PresenceInput,
  ProfileInput,
  PublicConsent} from './users.models';
import {
  LEGAL_CHOICE_TYPES,
  LOOKING_FOR_VALUES,
  ONBOARDING_LEGAL_CHOICE_TYPES,
  SEXES,
  legalDocumentUrl,
  legalDocumentVersion,
} from './users.models';
import { UsersRepository } from './users.repository';

export { ConsentChange, PreferencesInput, PresenceInput, ProfileInput } from './users.models';

@Injectable()
export class UsersService {
  constructor(
    private readonly users: UsersRepository,
    private readonly config: ConfigService,
    private readonly discovery: DiscoveryStore,
  ) {}

  async getProfile(userId: string): Promise<PublicProfile> {
    const profile = await this.users.findProfile(userId);
    if (!profile) throw apiError(404, 'profile_not_found', 'The account exists, but its profile has not been completed yet.');
    return toPublicProfile(profile);
  }

  async updateProfile(userId: string, input: ProfileInput): Promise<void> {
    const firstname = input.firstname.trim();
    const birthdate = parseIsoBirthdate(input.birthdate);
    if (!firstname || Buffer.byteLength(firstname) > 100 || !birthdate || !isAdult(birthdate)) {
      throw apiError(400, 'invalid_profile', 'The profile does not meet the required constraints.');
    }
    if (input.sex !== null && !SEXES.includes(input.sex)) {
      throw apiError(400, 'invalid_profile', 'The profile does not meet the required constraints.');
    }
    await this.requireLegalChoices(userId, input.sex === null
      ? ['terms_of_service_acceptance', 'privacy_notice_acknowledgement']
      : ['terms_of_service_acceptance', 'privacy_notice_acknowledgement', 'sensitive_data_consent']);
    const bio = input.bio === null ? null : input.bio.trim();
    if (bio !== null && Buffer.byteLength(bio) > 2_000) throw apiError(400, 'invalid_profile', 'The profile does not meet the required constraints.');
    const photo = input.photo === null ? null : input.photo.trim();
    if (photo !== null && (Buffer.byteLength(photo) > 2_048 || !isHttpUrl(photo))) {
      throw apiError(400, 'invalid_profile', 'The profile does not meet the required constraints.');
    }
    if (!await this.users.upsertProfile(userId, { firstname, birthdate: input.birthdate, sex: input.sex, bio, photo })) {
      throw apiError(404, 'account_not_found', 'The account could not be found or has been deleted.');
    }
  }

  async getPreferences(userId: string): Promise<PreferencesRow> {
    const preferences = await this.users.findPreferences(userId);
    if (!preferences) throw apiError(404, 'preferences_not_found', 'The account preferences could not be found.');
    return preferences;
  }

  async updatePreferences(userId: string, input: PreferencesInput): Promise<void> {
    const lookingFor = input.looking_for.trim();
    if (!Number.isInteger(input.min_age) || !Number.isInteger(input.max_age) || !Number.isInteger(input.max_distance_km)
      || input.min_age < 18 || input.max_age < input.min_age || input.max_age > 99 || input.max_distance_km < 1 || input.max_distance_km > 500
      || !LOOKING_FOR_VALUES.includes(lookingFor as PreferencesInput['looking_for'])) {
      throw apiError(400, 'invalid_preferences', 'The preferences do not meet the required constraints.');
    }
    await this.requireLegalChoices(userId, [
      'terms_of_service_acceptance',
      'privacy_notice_acknowledgement',
      'sensitive_data_consent',
    ]);
    if (!await this.users.upsertPreferences(userId, { ...input, looking_for: lookingFor as PreferencesInput['looking_for'] })) {
      throw apiError(404, 'account_not_found', 'The account could not be found or has been deleted.');
    }
  }

  async updatePresence(userId: string, input: PresenceInput): Promise<void> {
    if (!Number.isFinite(input.latitude) || !Number.isFinite(input.longitude) || input.latitude < -90 || input.latitude > 90 || input.longitude < -180 || input.longitude > 180) {
      throw apiError(400, 'invalid_presence', 'The location does not contain valid coordinates.');
    }
    await this.requireLegalChoices(userId, [
      'terms_of_service_acceptance',
      'privacy_notice_acknowledgement',
      'location_consent',
    ]);
    if (!await this.users.upsertPresence(userId, input, new Date())) {
      throw apiError(404, 'account_not_found', 'The account could not be found or has been deleted.');
    }
  }

  async anonymize(userId: string): Promise<void> {
    try {
      await this.discovery.deleteUserData(userId);
    } catch (error) {
      if (error instanceof ScyllaUnavailableError) {
        throw apiError(503, 'data_erasure_unavailable', 'Complete account erasure is temporarily unavailable.', error);
      }
      throw error;
    }
    await this.users.anonymize(userId);
  }

  async getConsents(userId: string): Promise<ConsentState> {
    const current = await this.users.currentConsents(userId);
    const byType = new Map(current.map((consent) => [consent.consent_type, consent]));
    const requiredActions = ONBOARDING_LEGAL_CHOICE_TYPES.filter((consentType) => {
      const consent = byType.get(consentType);
      return !consent?.granted || consent.document_version !== this.documentVersion(consentType);
    });
    return {
      consents: LEGAL_CHOICE_TYPES.map((consentType) => {
        const consent = byType.get(consentType);
        const requiredDocumentVersion = this.documentVersion(consentType);
        const documentUrl = legalDocumentUrl(consentType, this.config.legal);
        if (!consent) return {
          consent_type: consentType,
          granted: false,
          required_document_version: requiredDocumentVersion,
          document_url: documentUrl,
        };
        const result: PublicConsent = {
          consent_type: consent.consent_type,
          granted: consent.granted,
          required_document_version: requiredDocumentVersion,
          document_url: documentUrl,
          updated_at: consent.granted_at,
        };
        if (consent.document_version) result.document_version = consent.document_version;
        return result;
      }),
      onboarding_complete: requiredActions.length === 0,
      required_actions: [...requiredActions],
    };
  }

  async updateConsents(userId: string, changes: ConsentChange[], ipAddress: string, userAgent: string | undefined): Promise<ConsentState> {
    const uniqueTypes = new Set(changes.map((change) => change.consent_type));
    const containsInvalidWithdrawal = changes.some((change) => !change.granted && (
      change.consent_type === 'terms_of_service_acceptance'
      || change.consent_type === 'privacy_notice_acknowledgement'
    ));
    if (!changes.length || uniqueTypes.size !== changes.length
      || changes.some((change) => !LEGAL_CHOICE_TYPES.includes(change.consent_type)) || containsInvalidWithdrawal) {
      throw apiError(400, 'invalid_consent_payload', 'The consent request body is invalid.');
    }
    const updated = await this.users.recordConsents(userId, changes.map((change) => ({
      ...change,
      document_version: this.documentVersion(change.consent_type),
    })), ipAddress, userAgent ?? '');
    if (!updated) throw apiError(404, 'account_not_found', 'The account could not be found or has been deleted.');
    return this.getConsents(userId);
  }

  private async requireLegalChoices(userId: string, required: ConsentType[]): Promise<void> {
    const active = new Map((await this.users.activeLegalChoices(userId, required))
      .map((choice) => [choice.consent_type, choice.document_version]));
    if (required.some((consentType) => active.get(consentType) !== this.documentVersion(consentType))) {
      throw apiError(403, 'required_consent_missing', 'The required consent has not been granted.');
    }
  }

  private documentVersion(consentType: ConsentType): string {
    return legalDocumentVersion(consentType, this.config.legal);
  }
}

function parseIsoBirthdate(value: string): { year: number; month: number; day: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalized = new Date(Date.UTC(year, month - 1, day));
  if (normalized.getUTCFullYear() !== year || normalized.getUTCMonth() !== month - 1 || normalized.getUTCDate() !== day) return undefined;
  return { year, month, day };
}

function isAdult(birthdate: { year: number; month: number; day: number }): boolean {
  const now = new Date();
  const thresholdYear = now.getUTCFullYear() - 18;
  if (birthdate.year !== thresholdYear) return birthdate.year < thresholdYear;
  const currentMonth = now.getUTCMonth() + 1;
  return birthdate.month < currentMonth || (birthdate.month === currentMonth && birthdate.day <= now.getUTCDate());
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.host;
  } catch {
    return false;
  }
}
