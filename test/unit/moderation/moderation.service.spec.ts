import { ModerationService } from '../../../src/moderation/moderation.service';

const CASE_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';

describe('ModerationService', () => {
  it('requires a coherent checklist before reviewing a photo', async () => {
    const repository = { review: jest.fn() };
    const service = new ModerationService(repository as never, {} as never);

    await expect(service.review(
      CASE_ID, 1, 'approved', 'Validation humaine',
      { face_detectable: true, sharp_enough: false, content_allowed: true },
      ADMIN_ID, 'admin',
    )).rejects.toEqual(expect.objectContaining({ status: 400, code: 'invalid_moderation_request' }));
    await expect(service.review(
      CASE_ID, 1, 'rejected', 'Refus humain',
      { face_detectable: true, sharp_enough: true, content_allowed: true },
      ADMIN_ID, 'admin',
    )).rejects.toEqual(expect.objectContaining({ status: 400, code: 'invalid_moderation_request' }));
    expect(repository.review).not.toHaveBeenCalled();
  });

  it.each([
    ['stale', 'moderation_case_stale'],
    ['not_actionable', 'moderation_review_not_allowed'],
  ] as const)('maps %s review conflicts to %s', async (result, code) => {
    const repository = { review: jest.fn().mockResolvedValue(result) };
    const service = new ModerationService(repository as never, {} as never);

    await expect(service.review(CASE_ID, 2, 'approved', 'Validation humaine', undefined, ADMIN_ID, 'admin'))
      .rejects.toEqual(expect.objectContaining({ status: 409, code }));
  });

  it('signs a photo only after the audited repository detail succeeds', async () => {
    const repository = { detail: jest.fn().mockResolvedValue({
      id: CASE_ID,
      user_id: ADMIN_ID,
      firstname: 'Alice',
      content_type: 'photo',
      status: 'pending',
      reason_codes: [],
      policy_version: 'local_vision_v1',
      version: 1,
      face_count: 1,
      sharpness_score: 100,
      nsfw_score: 0.01,
      face_detectable: null,
      sharp_enough: null,
      content_allowed: null,
      review_reason: null,
      reviewed_at: null,
      reviewed_by: null,
      created_at: new Date('2030-01-01T00:00:00.000Z'),
      updated_at: new Date('2030-01-01T00:00:00.000Z'),
      cursor_at: '2030-01-01T00:00:00.000000Z',
      text_content: null,
      question: null,
      object_key: `profile-photos/${ADMIN_ID}/${CASE_ID}.webp`,
    }) };
    const photos = { urlForKey: jest.fn().mockResolvedValue('https://storage.test/signed') };
    const service = new ModerationService(repository as never, photos as never);

    await expect(service.detail(CASE_ID, ADMIN_ID, 'admin', 'Contrôle manuel')).resolves.toEqual(
      expect.objectContaining({ case_id: CASE_ID, photo: 'https://storage.test/signed' }),
    );
    expect(repository.detail).toHaveBeenCalledWith(CASE_ID, ADMIN_ID, 'admin', 'Contrôle manuel');
    expect(repository.detail.mock.invocationCallOrder[0]).toBeLessThan(photos.urlForKey.mock.invocationCallOrder[0]!);
  });
});
