import { InvalidPhotoError } from '../../../src/photos/photo-processor.service';
import { PhotosService } from '../../../src/photos/photos.service';
import { ObjectStorageUnavailableError } from '../../../src/storage/object-storage.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OLD_PHOTO = {
  id: '22222222-2222-4222-8222-222222222222',
  user_id: USER_ID,
  object_key: `profile-photos/${USER_ID}/22222222-2222-4222-8222-222222222222.webp`,
  status: 'deleting',
};
const UPLOAD = {
  filename: 'portrait.jpeg',
  mimetype: 'image/jpeg',
  body: Buffer.from('source'),
};
const PROCESSED = {
  body: Buffer.from('normalized-webp'),
  mimeType: 'image/webp',
  sizeBytes: 15,
  width: 320,
  height: 240,
  sha256: Buffer.alloc(32, 1),
};

describe('PhotosService', () => {
  it('persists metadata, uploads a versioned WebP and activates it', async () => {
    const repository = repositoryMock();
    const processor = { toWebp: jest.fn().mockResolvedValue(PROCESSED) };
    const storage = storageMock();
    const service = new PhotosService(
      repository as never,
      processor as never,
      storage as never,
    );

    await expect(service.upload(USER_ID, UPLOAD)).resolves.toBe(
      'https://storage.test/signed',
    );

    const processing = repository.createProcessing.mock.calls[0]?.[0] as {
      id: string;
      objectKey: string;
    };
    expect(processing.objectKey).toBe(
      `profile-photos/${USER_ID}/${processing.id}.webp`,
    );
    expect(repository.recordProcessed).toHaveBeenCalledWith(
      processing.id,
      USER_ID,
      expect.objectContaining({
        mimeType: 'image/webp',
        sizeBytes: PROCESSED.sizeBytes,
        width: PROCESSED.width,
        height: PROCESSED.height,
        sha256: PROCESSED.sha256,
      }),
    );
    expect(storage.put).toHaveBeenCalledWith({
      key: processing.objectKey,
      body: PROCESSED.body,
      contentType: 'image/webp',
      cacheControl: 'private, max-age=300',
    });
    expect(repository.activate).toHaveBeenCalledWith(processing.id, USER_ID);
    expect(storage.signedGetUrl).toHaveBeenCalledWith(processing.objectKey, 300);
  });

  it('retires the old object without failing an already activated replacement', async () => {
    const repository = repositoryMock();
    repository.activate.mockResolvedValue({
      activated: true,
      previous: [OLD_PHOTO],
    });
    const processor = { toWebp: jest.fn().mockResolvedValue(PROCESSED) };
    const storage = storageMock();
    storage.delete.mockRejectedValue(
      new ObjectStorageUnavailableError(new Error('offline')),
    );
    const service = new PhotosService(
      repository as never,
      processor as never,
      storage as never,
    );

    await expect(service.upload(USER_ID, UPLOAD)).resolves.toBe(
      'https://storage.test/signed',
    );
    expect(storage.delete).toHaveBeenCalledWith(OLD_PHOTO.object_key);
    expect(repository.completeDeletion).not.toHaveBeenCalled();
  });

  it('marks a ready photo deleting before removing its object', async () => {
    const repository = repositoryMock();
    repository.beginDelete.mockResolvedValue({
      profileFound: true,
      photo: OLD_PHOTO,
    });
    const storage = storageMock();
    const service = new PhotosService(
      repository as never,
      {} as never,
      storage as never,
    );

    await expect(service.delete(USER_ID)).resolves.toBeUndefined();
    expect(storage.delete).toHaveBeenCalledWith(OLD_PHOTO.object_key);
    expect(repository.completeDeletion).toHaveBeenCalledWith(OLD_PHOTO.id);
  });

  it('discards DB state when image validation fails before upload', async () => {
    const repository = repositoryMock();
    const processor = {
      toWebp: jest.fn().mockRejectedValue(new InvalidPhotoError()),
    };
    const service = new PhotosService(
      repository as never,
      processor as never,
      storageMock() as never,
    );

    await expect(service.upload(USER_ID, UPLOAD)).rejects.toEqual(
      expect.objectContaining({ status: 400, code: 'invalid_photo' }),
    );
    const photoId = repository.createProcessing.mock.calls[0]?.[0].id;
    expect(repository.discardProcessing).toHaveBeenCalledWith(photoId, USER_ID);
  });

  it('keeps processing state for reconciliation when upload outcome is uncertain', async () => {
    const repository = repositoryMock();
    const processor = { toWebp: jest.fn().mockResolvedValue(PROCESSED) };
    const storage = storageMock();
    storage.put.mockRejectedValue(
      new ObjectStorageUnavailableError(new Error('offline')),
    );
    const service = new PhotosService(
      repository as never,
      processor as never,
      storage as never,
    );

    await expect(service.upload(USER_ID, UPLOAD)).rejects.toEqual(
      expect.objectContaining({
        status: 503,
        code: 'photo_storage_unavailable',
      }),
    );
    expect(repository.discardProcessing).not.toHaveBeenCalled();
    expect(repository.activate).not.toHaveBeenCalled();
  });

  it('refuses to sign a key outside the versioned profile-photo namespace', async () => {
    const storage = storageMock();
    const service = new PhotosService({} as never, {} as never, storage as never);

    await expect(service.urlForKey('../public/photo.webp')).resolves.toBeNull();
    expect(storage.signedGetUrl).not.toHaveBeenCalled();
  });

  it('fails account erasure while retaining every object not confirmed deleted', async () => {
    const repository = repositoryMock();
    const secondPhoto = {
      ...OLD_PHOTO,
      id: '33333333-3333-4333-8333-333333333333',
      object_key: `profile-photos/${USER_ID}/33333333-3333-4333-8333-333333333333.webp`,
    };
    repository.beginAccountDeletion.mockResolvedValue([
      OLD_PHOTO,
      secondPhoto,
    ]);
    const storage = storageMock();
    storage.delete
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new ObjectStorageUnavailableError(new Error('offline')),
      );
    const service = new PhotosService(
      repository as never,
      {} as never,
      storage as never,
    );

    await expect(service.deleteForAccount(USER_ID)).rejects.toEqual(
      expect.objectContaining({
        status: 503,
        code: 'data_erasure_unavailable',
      }),
    );
    expect(repository.completeDeletion).toHaveBeenCalledTimes(1);
    expect(repository.completeDeletion).toHaveBeenCalledWith(OLD_PHOTO.id);
  });
});

function repositoryMock(): Record<string, jest.Mock> {
  return {
    createProcessing: jest.fn().mockResolvedValue('created'),
    recordProcessed: jest.fn().mockResolvedValue(true),
    activate: jest.fn().mockResolvedValue({ activated: true, previous: [] }),
    beginDelete: jest.fn().mockResolvedValue({ profileFound: true }),
    beginAccountDeletion: jest.fn().mockResolvedValue([]),
    completeDeletion: jest.fn().mockResolvedValue(undefined),
    discardProcessing: jest.fn().mockResolvedValue(undefined),
  };
}

function storageMock(): Record<string, jest.Mock> {
  return {
    put: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    signedGetUrl: jest.fn().mockResolvedValue('https://storage.test/signed'),
  };
}
