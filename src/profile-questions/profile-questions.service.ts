import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { apiError } from '../common/api-error';
import type {
  AdminProfileQuestion,
  ProfileAnswer,
  ProfileAnswerInput,
  ProfileQuestion,
  ProfileQuestionInput,
} from './profile-questions.models';
import { ProfileQuestionsRepository } from './profile-questions.repository';
import { TextModerationService } from '../moderation/text-moderation.service';

@Injectable()
export class ProfileQuestionsService {
  constructor(
    private readonly questions: ProfileQuestionsRepository,
    private readonly moderation: TextModerationService = new TextModerationService(),
  ) {}

  list(): Promise<ProfileQuestion[]> {
    return this.questions.list();
  }

  listForAdmin(): Promise<AdminProfileQuestion[]> {
    return this.questions.listForAdmin();
  }

  listForUser(userId: string): Promise<ProfileAnswer[]> {
    return this.questions.listForUser(userId);
  }

  async replaceForUser(userId: string, input: ProfileAnswerInput[]): Promise<ProfileAnswer[]> {
    const questionIds = new Set(input.map((answer) => answer.question_id));
    if (input.length > 3 || questionIds.size !== input.length) throwInvalidAnswers();
    const answers = input.map((answer) => {
      const normalized = normalizeAnswer(answer.answer);
      return { ...answer, answer: normalized, moderation: this.moderation.analyze(normalized) };
    });
    const result = await this.questions.replaceForUser(userId, answers);
    if (result === 'profile_not_found') {
      throw apiError(404, 'profile_not_found', 'The account exists, but its profile has not been completed yet.');
    }
    if (result === 'question_not_found') {
      throw apiError(404, 'profile_question_not_found', 'At least one profile question could not be found.');
    }
    return this.questions.listForUser(userId);
  }

  async create(input: ProfileQuestionInput): Promise<AdminProfileQuestion> {
    const normalized = normalizeQuestion(input);
    const id = randomUUID();
    try {
      return await this.questions.create(id, `custom_${id.replaceAll('-', '')}`, normalized);
    } catch (error) {
      throwQuestionConflict(error);
    }
  }

  async update(id: string, input: Partial<ProfileQuestionInput>): Promise<AdminProfileQuestion> {
    if (input.prompt === undefined && input.category === undefined && input.display_order === undefined) {
      throw apiError(400, 'invalid_profile_question_payload', 'At least one profile question field must be provided.');
    }
    const normalized = normalizeQuestion(input);
    try {
      const question = await this.questions.update(id, normalized);
      if (!question) throw apiError(404, 'profile_question_not_found', 'The profile question could not be found.');
      return question;
    } catch (error) {
      throwQuestionConflict(error);
    }
  }

  async delete(id: string): Promise<void> {
    if (!await this.questions.delete(id)) {
      throw apiError(404, 'profile_question_not_found', 'The profile question could not be found.');
    }
  }
}

function normalizeQuestion<T extends Partial<ProfileQuestionInput>>(input: T): T {
  const prompt = input.prompt?.normalize('NFKC').trim();
  if (prompt !== undefined) {
    const characterCount = Array.from(prompt).length;
    if (characterCount < 3 || characterCount > 200
      || hasControlCharacter(prompt) || Buffer.byteLength(prompt) > 500) {
      throw apiError(400, 'invalid_profile_question_payload', 'The profile question request body is invalid.');
    }
  }
  return { ...input, ...(prompt === undefined ? {} : { prompt }) };
}

function normalizeAnswer(value: string): string {
  const answer = value.normalize('NFKC').trim();
  const characterCount = Array.from(answer).length;
  if (characterCount < 10 || characterCount > 300
    || Buffer.byteLength(answer) > 1000 || hasControlCharacter(answer)) throwInvalidAnswers();
  return answer;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
}

function throwInvalidAnswers(): never {
  throw apiError(400, 'invalid_profile_answers', 'Profile answers must use distinct questions and contain between 10 and 300 characters.');
}

function throwQuestionConflict(error: unknown): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
    throw apiError(409, 'profile_question_already_exists', 'A profile question with this prompt already exists.', error);
  }
  throw error;
}
