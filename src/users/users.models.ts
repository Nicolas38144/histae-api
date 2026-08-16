export const SEXES = ['male', 'female', 'other'] as const;
export type Sex = typeof SEXES[number];

export const LOOKING_FOR_VALUES = ['male', 'female', 'both', 'other'] as const;
export type LookingFor = typeof LOOKING_FOR_VALUES[number];

export type ProfileRow = {
  user_id: string;
  firstname: string;
  birthdate: Date | string;
  sex: Sex | null;
  bio: string | null;
  photo: string | null;
};

export type PreferencesRow = {
  user_id: string;
  min_age: number;
  max_age: number;
  max_distance_km: number;
  looking_for: LookingFor;
};

export type ProfileInput = { firstname: string; birthdate: string; sex: Sex | null; bio: string | null; photo: string | null };
export type PreferencesInput = { min_age: number; max_age: number; max_distance_km: number; looking_for: LookingFor };
export type PresenceInput = { latitude: number; longitude: number };

export const LEGAL_CHOICE_TYPES = [
  'terms_of_service_acceptance',
  'privacy_notice_acknowledgement',
  'sensitive_data_consent',
  'location_consent',
] as const;

export type ConsentType = typeof LEGAL_CHOICE_TYPES[number];

export const ONBOARDING_LEGAL_CHOICE_TYPES = [
  'terms_of_service_acceptance',
  'privacy_notice_acknowledgement',
] as const satisfies readonly ConsentType[];

export type LegalDocumentVersions = {
  termsVersion: string;
  privacyVersion: string;
  sensitiveDataConsentVersion: string;
  locationConsentVersion: string;
  termsUrl: string;
  privacyUrl: string;
  sensitiveDataConsentUrl: string;
  locationConsentUrl: string;
};

export function legalDocumentVersion(consentType: ConsentType, versions: LegalDocumentVersions): string {
  if (consentType === 'terms_of_service_acceptance') return versions.termsVersion;
  if (consentType === 'privacy_notice_acknowledgement') return versions.privacyVersion;
  if (consentType === 'sensitive_data_consent') return versions.sensitiveDataConsentVersion;
  return versions.locationConsentVersion;
}

export function legalDocumentUrl(consentType: ConsentType, documents: LegalDocumentVersions): string {
  if (consentType === 'terms_of_service_acceptance') return documents.termsUrl;
  if (consentType === 'privacy_notice_acknowledgement') return documents.privacyUrl;
  if (consentType === 'sensitive_data_consent') return documents.sensitiveDataConsentUrl;
  return documents.locationConsentUrl;
}

export type ConsentChange = { consent_type: ConsentType; granted: boolean };

export type ConsentEvent = ConsentChange & {
  document_version: string;
  granted_at: Date;
  withdrawn_at: Date | null;
};

export type PublicConsent = {
  consent_type: ConsentType;
  granted: boolean;
  document_version?: string;
  required_document_version: string;
  document_url: string;
  updated_at?: Date;
};

export type ConsentState = {
  consents: PublicConsent[];
  onboarding_complete: boolean;
  required_actions: ConsentType[];
};
