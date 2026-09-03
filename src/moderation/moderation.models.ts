export const MODERATION_CONTENT_TYPES = ['photo', 'bio', 'profile_answer'] as const;
export type ModerationContentType = typeof MODERATION_CONTENT_TYPES[number];

export const MODERATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ModerationStatus = typeof MODERATION_STATUSES[number];

export const MODERATION_DECISIONS = ['approved', 'rejected'] as const;
export type ModerationDecision = typeof MODERATION_DECISIONS[number];

export const MODERATION_REASON_CODES = [
  'spam',
  'insult',
  'personal_contact',
  'sexual_content',
  'face_not_detected',
  'multiple_faces',
  'blurry',
  'explicit_image',
  'analysis_unavailable',
  'legacy_unreviewed',
] as const;
export type ModerationReasonCode = typeof MODERATION_REASON_CODES[number];

export type AutomatedModerationDecision = {
  status: Extract<ModerationStatus, 'pending' | 'approved'>;
  reasonCodes: ModerationReasonCode[];
  policyVersion: string;
};

export type AutomatedPhotoModeration = AutomatedModerationDecision & {
  faceCount: number | null;
  sharpnessScore: number | null;
  nsfwScore: number | null;
};

export type PhotoReviewChecks = {
  face_detectable: boolean;
  sharp_enough: boolean;
  content_allowed: boolean;
};

export type ModerationCaseRow = {
  id: string;
  user_id: string;
  firstname: string | null;
  content_type: ModerationContentType;
  status: ModerationStatus;
  reason_codes: ModerationReasonCode[];
  policy_version: string;
  version: number;
  face_count: number | null;
  sharpness_score: number | null;
  nsfw_score: number | null;
  face_detectable: boolean | null;
  sharp_enough: boolean | null;
  content_allowed: boolean | null;
  review_reason: string | null;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  created_at: Date;
  updated_at: Date;
  cursor_at: string;
};

export type ModerationCase = Omit<ModerationCaseRow, 'id' | 'cursor_at'> & {
  case_id: string;
};

export type ModerationDetailRow = ModerationCaseRow & {
  text_content: string | null;
  question: string | null;
  object_key: string | null;
};

export type ModerationDetail = ModerationCase & {
  content: string | null;
  question: string | null;
  photo: string | null;
};

export type ModerationReviewInput = {
  version: number;
  decision: ModerationDecision;
  reason: string;
  photoChecks?: PhotoReviewChecks;
};

export type ModerationReviewResult = 'updated' | 'not_found' | 'stale' | 'not_actionable';
