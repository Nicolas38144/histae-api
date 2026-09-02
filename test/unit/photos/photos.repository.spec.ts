import { PhotosRepository } from '../../../src/photos/photos.repository';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PHOTO_ID = '22222222-2222-4222-8222-222222222222';
const IDEMPOTENCY_KEY = '33333333-3333-4333-8333-333333333333';
const OBJECT_KEY = `profile-photos/${USER_ID}/${PHOTO_ID}.webp`;
const CREATED_AT = new Date('2026-09-02T10:00:00.000Z');
const EXPIRES_AT = new Date('2026-09-03T10:00:00.000Z');
const REQUEST_SHA256 = Buffer.alloc(32, 1);

describe('PhotosRepository', () => {
  it('creates photo and idempotency state while holding the profile lock', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ user_id: USER_ID }] })
        .mockResolvedValueOnce({ rowCount: 0 })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1 }),
    };
    const repository = createRepository(transactionalDatabase(client));

    await expect(repository.createProcessing(processingPhoto())).resolves
      .toEqual({ state: 'created' });

    expect(client.query.mock.calls[0]?.[0]).toContain('FOR UPDATE OF profile');
    expect(client.query.mock.calls[4]?.[0]).toContain('INSERT INTO user_photo');
    expect(client.query.mock.calls[5]?.[0]).toContain(
      'INSERT INTO photo_upload_request',
    );
    expect(client.query.mock.calls[5]?.[1]).toEqual([
      USER_ID,
      IDEMPOTENCY_KEY,
      REQUEST_SHA256,
      PHOTO_ID,
      CREATED_AT,
      EXPIRES_AT,
    ]);
  });

  it('replays a completed request only while its photo is still ready', async () => {
    const existing = {
      requestSha256: REQUEST_SHA256,
      requestStatus: 'completed',
      photoId: PHOTO_ID,
      userId: USER_ID,
      objectKey: OBJECT_KEY,
      photoStatus: 'ready',
    };
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ user_id: USER_ID }] })
        .mockResolvedValueOnce({ rowCount: 0 })
        .mockResolvedValueOnce({ rows: [existing] }),
    };
    const repository = createRepository(transactionalDatabase(client));

    await expect(repository.createProcessing(processingPhoto())).resolves
      .toEqual({
        state: 'replay',
        photo: {
          id: PHOTO_ID,
          userId: USER_ID,
          objectKey: OBJECT_KEY,
          status: 'ready',
        },
      });
    expect(client.query).toHaveBeenCalledTimes(3);
  });

  it('rejects reuse of an idempotency key for another payload', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ user_id: USER_ID }] })
        .mockResolvedValueOnce({ rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{
          requestSha256: Buffer.alloc(32, 2),
          requestStatus: 'completed',
          photoId: PHOTO_ID,
          userId: USER_ID,
          objectKey: OBJECT_KEY,
          photoStatus: 'ready',
        }] }),
    };
    const repository = createRepository(transactionalDatabase(client));

    await expect(repository.createProcessing(processingPhoto())).resolves
      .toEqual({ state: 'idempotency_conflict' });
  });

  it('does not create a second concurrent upload', async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ user_id: USER_ID }] })
        .mockResolvedValueOnce({ rowCount: 0 })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ exists: 1 }] }),
    };
    const repository = createRepository(transactionalDatabase(client));

    await expect(repository.createProcessing(processingPhoto())).resolves
      .toEqual({ state: 'update_in_progress' });
    expect(client.query).toHaveBeenCalledTimes(4);
  });

  it('returns profile_not_found before creating storage state', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const repository = createRepository(transactionalDatabase(client));

    await expect(repository.createProcessing(processingPhoto())).resolves
      .toEqual({ state: 'profile_not_found' });
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('persists the normalized WebP metadata before object activation', async () => {
    const database = { query: jest.fn().mockResolvedValue({ rowCount: 1 }) };
    const repository = createRepository(database);
    const sha256 = Buffer.alloc(32, 1);

    await expect(repository.recordProcessed(PHOTO_ID, USER_ID, {
      mimeType: 'image/webp',
      sizeBytes: 123_456,
      width: 800,
      height: 600,
      sha256,
    })).resolves.toBe(true);
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

  it('atomically activates the candidate and enqueues deletion of the old photo', async () => {
    const previous = {
      id: '44444444-4444-4444-8444-444444444444',
      userId: USER_ID,
      objectKey: `profile-photos/${USER_ID}/44444444-4444-4444-8444-444444444444.webp`,
      status: 'deleting',
    };
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ user_id: USER_ID }] })
        .mockResolvedValueOnce({ rows: [{ exists: 1 }] })
        .mockResolvedValueOnce({ rows: [previous] })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rowCount: 1 }),
    };
    const outbox = { enqueue: jest.fn().mockResolvedValue(true) };
    const repository = new PhotosRepository(
      transactionalDatabase(client) as never,
      outbox as never,
    );

    await expect(repository.activate(PHOTO_ID, USER_ID)).resolves.toBe(true);
    expect(outbox.enqueue).toHaveBeenCalledWith(client, {
      eventType: 'photo.delete',
      aggregateId: previous.id,
    });
    expect(client.query.mock.calls[3]?.[0]).toContain("status = 'ready'");
    expect(client.query.mock.calls[4]?.[0]).toContain(
      "status = 'completed'",
    );
  });

  it('enqueues a manual photo deletion in the same transaction', async () => {
    const photo = {
      id: PHOTO_ID,
      userId: USER_ID,
      objectKey: OBJECT_KEY,
      status: 'deleting',
    };
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ user_id: USER_ID }] })
        .mockResolvedValueOnce({ rows: [photo] }),
    };
    const outbox = { enqueue: jest.fn().mockResolvedValue(true) };
    const repository = new PhotosRepository(
      transactionalDatabase(client) as never,
      outbox as never,
    );

    await expect(repository.beginDelete(USER_ID)).resolves.toBe(true);
    expect(outbox.enqueue).toHaveBeenCalledWith(client, {
      eventType: 'photo.delete',
      aggregateId: PHOTO_ID,
    });
  });

  it('claims stale uploads and failed deletions for idempotent cleanup', async () => {
    const photo = {
      id: PHOTO_ID,
      userId: USER_ID,
      objectKey: OBJECT_KEY,
      status: 'deleting',
    };
    const database = { query: jest.fn().mockResolvedValue({ rows: [photo] }) };
    const repository = createRepository(database);
    const now = new Date('2026-09-01T12:00:00.000Z');

    await expect(repository.claimCleanupBatch(
      now,
      new Date('2026-09-01T11:30:00.000Z'),
      new Date('2026-09-01T11:55:00.000Z'),
      100,
    )).resolves.toEqual([photo]);
    expect(database.query.mock.calls[0]?.[0]).toContain(
      'FOR UPDATE SKIP LOCKED',
    );
  });
});

function processingPhoto() {
  return {
    id: PHOTO_ID,
    userId: USER_ID,
    objectKey: OBJECT_KEY,
    idempotencyKey: IDEMPOTENCY_KEY,
    requestSha256: REQUEST_SHA256,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
  };
}

function createRepository(database: unknown): PhotosRepository {
  return new PhotosRepository(
    database as never,
    { enqueue: jest.fn().mockResolvedValue(true) } as never,
  );
}

function transactionalDatabase(client: { query: jest.Mock }): {
  transaction: jest.Mock;
} {
  return {
    transaction: jest.fn(async (
      work: (transactionClient: typeof client) => Promise<unknown>,
    ) => work(client)),
  };
}
