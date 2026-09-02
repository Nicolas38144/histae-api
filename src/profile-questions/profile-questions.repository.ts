import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type {
  AdminProfileQuestion,
  ProfileAnswer,
  ProfileAnswerInput,
  ProfileQuestion,
  ProfileQuestionInput,
} from './profile-questions.models';

@Injectable()
export class ProfileQuestionsRepository {
  constructor(private readonly database: DatabaseService) {}

  async list(): Promise<ProfileQuestion[]> {
    return (await this.database.query<ProfileQuestion>(`
      SELECT id, code, prompt, category, display_order
      FROM profile_question
      ORDER BY display_order, id
    `)).rows;
  }

  async listForAdmin(): Promise<AdminProfileQuestion[]> {
    return (await this.database.query<AdminProfileQuestion>(`
      SELECT question.id, question.code, question.prompt, question.category,
        question.display_order, question.created_at, question.updated_at,
        count(answer.id)::integer AS answer_count
      FROM profile_question AS question
      LEFT JOIN user_profile_answer AS answer ON answer.question_id = question.id
      GROUP BY question.id
      ORDER BY question.display_order, question.id
    `)).rows;
  }

  async listForUser(userId: string): Promise<ProfileAnswer[]> {
    return (await this.database.query<ProfileAnswer>(`
      SELECT answer.question_id, question.code, question.prompt AS question,
        answer.answer, answer.position::integer AS position
      FROM user_profile_answer AS answer
      JOIN profile_question AS question ON question.id = answer.question_id
      WHERE answer.user_id = $1
      ORDER BY answer.position
    `, [userId])).rows;
  }

  async replaceForUser(userId: string, answers: ProfileAnswerInput[]): Promise<'updated' | 'profile_not_found' | 'question_not_found'> {
    return this.database.transaction(async (client) => {
      const profile = await client.query<{ user_id: string }>(`
        SELECT profile.user_id
        FROM user_profile AS profile
        JOIN user_account AS account ON account.user_id = profile.user_id
        WHERE profile.user_id = $1 AND account.deleted_at IS NULL
        FOR UPDATE OF profile
      `, [userId]);
      if (!profile.rows[0]) return 'profile_not_found';

      const questionIds = answers.map((answer) => answer.question_id);
      if (questionIds.length) {
        const questions = await client.query<{ id: string }>(`
          SELECT id FROM profile_question WHERE id = ANY($1::uuid[]) FOR SHARE
        `, [questionIds]);
        if (questions.rows.length !== questionIds.length) return 'question_not_found';
      }

      await client.query('DELETE FROM user_profile_answer WHERE user_id = $1', [userId]);
      for (const [index, answer] of answers.entries()) {
        await client.query(`
          INSERT INTO user_profile_answer (user_id, question_id, answer, position)
          VALUES ($1, $2, $3, $4)
        `, [userId, answer.question_id, answer.answer, index + 1]);
      }
      return 'updated';
    });
  }

  async create(id: string, code: string, input: ProfileQuestionInput): Promise<AdminProfileQuestion> {
    return (await this.database.query<AdminProfileQuestion>(`
      INSERT INTO profile_question (id, code, prompt, category, display_order)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, code, prompt, category, display_order, created_at, updated_at,
        0::integer AS answer_count
    `, [id, code, input.prompt, input.category, input.display_order])).rows[0]!;
  }

  async update(id: string, input: Partial<ProfileQuestionInput>): Promise<AdminProfileQuestion | undefined> {
    return (await this.database.query<AdminProfileQuestion>(`
      UPDATE profile_question AS question
      SET prompt = COALESCE($2, prompt), category = COALESCE($3, category),
        display_order = COALESCE($4, display_order), updated_at = clock_timestamp()
      WHERE id = $1
      RETURNING id, code, prompt, category, display_order, created_at, updated_at,
        (SELECT count(*)::integer FROM user_profile_answer WHERE question_id = question.id) AS answer_count
    `, [id, input.prompt ?? null, input.category ?? null, input.display_order ?? null])).rows[0];
  }

  async delete(id: string): Promise<boolean> {
    return (await this.database.query('DELETE FROM profile_question WHERE id = $1', [id])).rowCount === 1;
  }
}
