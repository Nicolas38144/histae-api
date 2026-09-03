import { ProfileQuestionsService } from '../../../src/profile-questions/profile-questions.service';

const QUESTION_ID = '11111111-1111-4111-8111-111111111111';

describe('ProfileQuestionsService', () => {
  it('normalizes and atomically replaces the selected answers', async () => {
    const repository = {
      replaceForUser: jest.fn().mockResolvedValue('updated'),
      listForUser: jest.fn().mockResolvedValue([{
        question_id: QUESTION_ID,
        code: 'ideal_sunday',
        question: 'À quoi ressemble ton dimanche idéal ?',
        answer: 'Une longue balade en forêt.',
        position: 1,
      }]),
    };
    const service = new ProfileQuestionsService(repository as never);

    await expect(service.replaceForUser('user-id', [{
      question_id: QUESTION_ID,
      answer: '  Une longue balade en forêt.  ',
    }])).resolves.toEqual([expect.objectContaining({ position: 1 })]);
    expect(repository.replaceForUser).toHaveBeenCalledWith('user-id', [{
      question_id: QUESTION_ID,
      answer: 'Une longue balade en forêt.',
      moderation: {
        status: 'approved',
        reasonCodes: [],
        policyVersion: 'text_rules_v1',
      },
    }]);
  });

  it('rejects duplicate questions and control characters before persistence', async () => {
    const repository = { replaceForUser: jest.fn() };
    const service = new ProfileQuestionsService(repository as never);

    await expect(service.replaceForUser('user-id', [
      { question_id: QUESTION_ID, answer: 'Première réponse valide.' },
      { question_id: QUESTION_ID, answer: 'Deuxième réponse valide.' },
    ])).rejects.toEqual(expect.objectContaining({ status: 400, code: 'invalid_profile_answers' }));
    await expect(service.replaceForUser('user-id', [
      { question_id: QUESTION_ID, answer: 'Réponse avec\nun saut.' },
    ])).rejects.toEqual(expect.objectContaining({ status: 400, code: 'invalid_profile_answers' }));
    await expect(service.replaceForUser('user-id', [
      { question_id: '12222222-2222-4222-8222-222222222222', answer: 'Première réponse valide.' },
      { question_id: '22222222-2222-4222-8222-222222222222', answer: 'Deuxième réponse valide.' },
      { question_id: '32222222-2222-4222-8222-222222222222', answer: 'Troisième réponse valide.' },
      { question_id: '42222222-2222-4222-8222-222222222222', answer: 'Quatrième réponse valide.' },
    ])).rejects.toEqual(expect.objectContaining({ status: 400, code: 'invalid_profile_answers' }));
    expect(repository.replaceForUser).not.toHaveBeenCalled();
  });

  it('returns stable errors for a missing profile or question', async () => {
    const repository = { replaceForUser: jest.fn(), listForUser: jest.fn() };
    const service = new ProfileQuestionsService(repository as never);
    repository.replaceForUser.mockResolvedValueOnce('profile_not_found');
    await expect(service.replaceForUser('user-id', [])).rejects.toEqual(
      expect.objectContaining({ status: 404, code: 'profile_not_found' }),
    );
    repository.replaceForUser.mockResolvedValueOnce('question_not_found');
    await expect(service.replaceForUser('user-id', [{
      question_id: QUESTION_ID,
      answer: 'Une réponse assez longue.',
    }])).rejects.toEqual(expect.objectContaining({ status: 404, code: 'profile_question_not_found' }));
  });

  it('creates normalized administrator questions with an opaque stable code', async () => {
    const repository = {
      create: jest.fn(async (id: string, code: string, input: object) => ({
        id, code, ...input, answer_count: 0,
      })),
    };
    const service = new ProfileQuestionsService(repository as never);

    const question = await service.create({
      prompt: '  Ton moment préféré de la journée ?  ',
      category: 'daily_life',
      display_order: 42,
    });
    expect(question).toEqual(expect.objectContaining({
      prompt: 'Ton moment préféré de la journée ?',
      code: expect.stringMatching(/^custom_[0-9a-f]{32}$/),
    }));
  });

  it('deletes a question and reports a missing catalog entry', async () => {
    const repository = { delete: jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) };
    const service = new ProfileQuestionsService(repository as never);

    await expect(service.delete(QUESTION_ID)).resolves.toBeUndefined();
    await expect(service.delete(QUESTION_ID)).rejects.toEqual(
      expect.objectContaining({ status: 404, code: 'profile_question_not_found' }),
    );
  });

  it('rejects an empty administrator update', async () => {
    const repository = { update: jest.fn() };
    const service = new ProfileQuestionsService(repository as never);

    await expect(service.update(QUESTION_ID, {})).rejects.toEqual(
      expect.objectContaining({ status: 400, code: 'invalid_profile_question_payload' }),
    );
    expect(repository.update).not.toHaveBeenCalled();
  });
});
