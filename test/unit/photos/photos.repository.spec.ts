import { PhotosRepository } from '../../../src/photos/photos.repository';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PHOTO_ID = '22222222-2222-4222-8222-222222222222';
const OBJECT_KEY = `profile-photos/${USER_ID}/${PHOTO_ID}.webp`;

describe('PhotosRepository', () => {
  it('creates a processing row while holding the profile lock', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ user_id: USER_ID }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rowCount: 1 }),
    };
    const database = transactionalDatabase(client);
    const repository = new PhotosRepository(database as never);

    await expect(repository.createProcessing({
      id: PHOTO_ID,
      userId: USER_ID,
      objectKey: OBJECT_KEY,
    })).resolves.toBe('created');

    expect(client.query.mock.calls[0]?.[0]).toContain('FOR UPDATE OF profile');
    expect(client.query.mock.calls[2]?.[0]).toContain('INSERT INTO user_photo');
    expect(client.query.mock.calls[2]?.[1]).toEqual([
      PHOTO_ID,
      USER_ID,
      OBJECT_KEY,
    ]);
  });

  it('does not create a second concurrent upload', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ user_id: USER_ID }] })
        .mockResolvedValueOnce({ rows: [{ exists: 1 }] }),
    };
    const repository = new PhotosRepository(
      transactionalDatabase(client) as never,
    );

    await expect(repository.createProcessing({
      id: PHOTO_ID,
      userId: USER_ID,
      objectKey: OBJECT_KEY,
    })).resolves.toBe('update_in_progress');
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it('returns profile_not_found before creating storage state', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const repository = new PhotosRepository(
      transactionalDatabase(client) as never,
    );

    await expect(repository.createProcessing({
      id: PHOTO_ID,
      userId: USER_ID,
      objectKey: OBJECT_KEY,
    })).resolves.toBe('profile_not_found');
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('persists the normalized WebP metadata before object activation', async () => {
    const database = { query: jest.fn().mockResolvedValue({ rowCount: 1 }) };
    const repository = new PhotosRepository(database as never);
    const sha256 = Buffer.alloc(32, 1);

    await expect(repository.recordProcessed(PHOTO_ID, USER_ID, {
      mimeType: 'image/webp',
      sizeBytes: 123_456,
      width: 800,
      height: 600,
      sha256,
    })).resolves.toBe(true);
    expect(database.query.mock.calls[0]?.[0]).toContain('UPDATE user_photo');
    expect(database.query.mock.calls[0]?.[1]).toEqual([
      PHOTO_ID,
      USER_ID,
      'image/webp',
      123_456,
      800,
      600,
      sha256,
    ]);
  });

  it('atomically retires the previous ready photo and activates the candidate', async () => {
    const previous = {
      id: '33333333-3333-4333-8333-333333333333',
      userId: USER_ID,
      objectKey: `profile-photos/${USER_ID}/33333333-3333-4333-8333-333333333333.webp`,
      status: 'deleting',
    };
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ user_id: USER_ID }] })
        .mockResolvedValueOnce({ rows: [{ exists: 1 }] })
        .mockResolvedValueOnce({ rows: [previous] })
        .mockResolvedValueOnce({ rowCount: 1 }),
    };
    const repository = new PhotosRepository(
      transactionalDatabase(client) as never,
    );

    await expect(repository.activate(PHOTO_ID, USER_ID)).resolves.toEqual({
      activated: true,
      previous: [previous],
    });
    expect(client.query.mock.calls[2]?.[0]).toContain("status = 'deleting'");
    expect(client.query.mock.calls[3]?.[0]).toContain("status = 'ready'");
  });

  it('claims stale uploads and failed deletions for idempotent cleanup', async () => {
    const photo = {
      id: PHOTO_ID,
      userId: USER_ID,
      objectKey: OBJECT_KEY,
      status: 'deleting',
    };
    const database = { query: jest.fn().mockResolvedValue({ rows: [photo] }) };
    const repository = new PhotosRepository(database as never);
    const now = new Date('2026-09-01T12:00:00.000Z');

    await expect(repository.claimCleanupBatch(
      now,
      new Date('2026-09-01T11:30:00.000Z'),
      new Date('2026-09-01T11:55:00.000Z'),
      100,
    )).resolves.toEqual([photo]);
    expect(database.query.mock.calls[0]?.[0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(database.query.mock.calls[0]?.[1]).toEqual([
      now,
      new Date('2026-09-01T11:30:00.000Z'),
      new Date('2026-09-01T11:55:00.000Z'),
      100,
    ]);
  });
});

function transactionalDatabase(client: { query: jest.Mock }): {
  transaction: jest.Mock;
} {
  return {
    transaction: jest.fn(async (
      work: (transactionClient: typeof client) => Promise<unknown>,
    ) => work(client)),
  };
}
