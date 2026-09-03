import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AdminSessionGuard } from '../../src/admin-auth/admin-auth.guard';
import { JwtActiveGuard } from '../../src/auth/auth.guard';
import type { AuthenticatedRequest } from '../../src/auth/auth.types';
import { ApiExceptionFilter } from '../../src/common/api-exception.filter';
import { ProfileQuestionsController } from '../../src/profile-questions/profile-questions.controller';
import { ProfileQuestionsService } from '../../src/profile-questions/profile-questions.service';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const QUESTION_ID = '22222222-2222-4222-8222-222222222222';

describe('Profile questions HTTP contract', () => {
  let app: NestFastifyApplication;
  const question = {
    id: QUESTION_ID,
    code: 'ideal_sunday',
    prompt: 'À quoi ressemble ton dimanche idéal ?',
    category: 'daily_life',
    display_order: 10,
  };
  const answer = {
    question_id: QUESTION_ID,
    code: question.code,
    question: question.prompt,
    answer: 'Une longue balade en forêt.',
    position: 1,
  };
  const questions = {
    list: jest.fn().mockResolvedValue([question]),
    listForUser: jest.fn().mockResolvedValue([answer]),
    replaceForUser: jest.fn().mockResolvedValue([answer]),
    listForAdmin: jest.fn().mockResolvedValue([{ ...question, answer_count: 4 }]),
    create: jest.fn().mockResolvedValue({ ...question, answer_count: 0 }),
    update: jest.fn().mockResolvedValue({ ...question, display_order: 20, answer_count: 4 }),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const activeGuard: CanActivate = {
    canActivate(context: ExecutionContext): boolean {
      const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
      request.auth = {
        userId: ADMIN_ID,
        account: { user_id: ADMIN_ID, role: 'admin', is_banned: false, onboarding_complete: true },
      };
      return true;
    },
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ProfileQuestionsController],
      providers: [{ provide: ProfileQuestionsService, useValue: questions }],
    })
      .overrideGuard(JwtActiveGuard).useValue(activeGuard)
      .overrideGuard(AdminSessionGuard).useValue(activeGuard)
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
  });

  afterAll(async () => app?.close());
  beforeEach(() => jest.clearAllMocks());

  it('lists the catalog and replaces the authenticated user answers', async () => {
    const catalog = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/api/profile-questions' });
    const mine = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/api/users/me/profile-answers' });
    const replaced = await app.getHttpAdapter().getInstance().inject({
      method: 'PUT',
      url: '/api/users/me/profile-answers',
      payload: { answers: [{ question_id: QUESTION_ID, answer: answer.answer }] },
    });

    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toEqual({ questions: [question] });
    expect(mine.json()).toEqual({ answers: [answer] });
    expect(replaced.json()).toEqual({ answers: [answer] });
    expect(questions.replaceForUser).toHaveBeenCalledWith(ADMIN_ID, [{
      question_id: QUESTION_ID,
      answer: answer.answer,
    }]);
  });

  it('rejects more than three answers and unknown fields', async () => {
    const values = Array.from({ length: 4 }, (_, index) => ({
      question_id: `${index + 3}2222222-2222-4222-8222-222222222222`,
      answer: 'Une réponse suffisamment longue.',
    }));
    const tooMany = await app.getHttpAdapter().getInstance().inject({
      method: 'PUT', url: '/api/users/me/profile-answers', payload: { answers: values },
    });
    const polluted = await app.getHttpAdapter().getInstance().inject({
      method: 'PUT', url: '/api/users/me/profile-answers', payload: { answers: [], unexpected: true },
    });

    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().error.code).toBe('invalid_profile_answers');
    expect(polluted.statusCode).toBe(400);
    expect(questions.replaceForUser).not.toHaveBeenCalled();
  });

  it('creates, updates and deletes catalog questions for administrators', async () => {
    const listed = await app.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/api/admin/profile-questions' });
    const created = await app.getHttpAdapter().getInstance().inject({
      method: 'POST', url: '/api/admin/profile-questions',
      payload: { prompt: question.prompt, category: question.category, display_order: 10 },
    });
    const updated = await app.getHttpAdapter().getInstance().inject({
      method: 'PATCH', url: `/api/admin/profile-questions/${QUESTION_ID}`,
      payload: { display_order: 20 },
    });
    const deleted = await app.getHttpAdapter().getInstance().inject({
      method: 'DELETE', url: `/api/admin/profile-questions/${QUESTION_ID}`,
    });

    expect(listed.json()).toEqual({ questions: [expect.objectContaining({ answer_count: 4 })] });
    expect(created.statusCode).toBe(201);
    expect(updated.statusCode).toBe(200);
    expect(deleted.statusCode).toBe(204);
    expect(questions.create).toHaveBeenCalledWith({
      prompt: question.prompt, category: question.category, display_order: 10,
    });
    expect(questions.update).toHaveBeenCalledWith(QUESTION_ID, { display_order: 20 });
    expect(questions.delete).toHaveBeenCalledWith(QUESTION_ID);
  });

  it('rejects invalid administrator mutations before the service', async () => {
    const invalid = await app.getHttpAdapter().getInstance().inject({
      method: 'POST', url: '/api/admin/profile-questions',
      payload: { prompt: 'ok', category: 'unsafe', display_order: -1 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('invalid_profile_question_payload');
    expect(questions.create).not.toHaveBeenCalled();
    expect(questions.update).not.toHaveBeenCalled();
  });
});
