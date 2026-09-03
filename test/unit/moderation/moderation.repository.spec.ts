import { ModerationRepository } from '../../../src/moderation/moderation.repository';

const CASE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const PHOTO_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = '44444444-4444-4444-8444-444444444444';

describe('ModerationRepository', () => {
  it('hides and queues a rejected photo in the same transaction as the audited decision', async () => {
    const client = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{
        user_id: USER_ID, content_type: 'photo', photo_id: PHOTO_ID,
        photo_status: 'ready', version: 2,
      }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 }) };
    const database = { transaction: jest.fn((work) => work(client)) };
    const outbox = { requeue: jest.fn().mockResolvedValue(undefined) };
    const repository = new ModerationRepository(database as never, outbox as never);

    await expect(repository.review(CASE_ID, {
      version: 2,
      decision: 'rejected',
      reason: 'Le visage n’est pas identifiable',
      photoChecks: { face_detectable: false, sharp_enough: true, content_allowed: true },
    }, ADMIN_ID, 'admin')).resolves.toBe('updated');

    expect(client.query.mock.calls[2]?.[0]).toContain("status = 'deleting'");
    expect(outbox.requeue).toHaveBeenCalledWith(client, {
      eventType: 'photo.delete', aggregateId: PHOTO_ID,
    });
    expect(client.query.mock.calls[3]?.[1]).toEqual([
      USER_ID, ADMIN_ID, 'admin', 'admin_review_content', 'Le visage n’est pas identifiable',
    ]);
  });
});
