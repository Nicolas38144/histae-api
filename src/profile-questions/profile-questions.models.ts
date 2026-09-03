import type {
  ModerationReasonCode,
  ModerationStatus,
} from '../moderation/moderation.models';

export const PROFILE_QUESTION_CATEGORIES = [
  'daily_life',
  'personality',
  'interests',
  'relationships',
  'conversation',
] as const;

export type ProfileQuestionCategory = typeof PROFILE_QUESTION_CATEGORIES[number];

export type ProfileQuestion = {
  id: string;
  code: string;
  prompt: string;
  category: ProfileQuestionCategory;
  display_order: number;
};

export type AdminProfileQuestion = ProfileQuestion & {
  answer_count: number;
  created_at: Date;
  updated_at: Date;
};

export type ProfileAnswer = {
  question_id: string;
  code: string;
  question: string;
  answer: string;
  position: number;
  moderation_status?: ModerationStatus;
  moderation_reasons?: ModerationReasonCode[];
};

export type ProfileAnswerInput = {
  question_id: string;
  answer: string;
};

export type ProfileQuestionInput = {
  prompt: string;
  category: ProfileQuestionCategory;
  display_order: number;
};
