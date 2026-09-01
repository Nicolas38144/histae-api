import { InvalidPhotoError } from '../../../src/photos/photo-processor.service';
import { PhotosService, profilePhotoKey } from '../../../src/photos/photos.service';
import { ObjectStorageUnavailableError } from '../../../src/storage/object-storage.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const KEY = profilePhotoKey(USER_ID);

describe('PhotosService', () => {
  it('stores only the normalized WebP key and returns a short-lived signed URL', async () => {
    const webp = Buffer.from('normalized-webp');
    const processor = { toWebp: jest.fn().mockResolvedValue(webp) };
    const repository = lockedRepository(null);
    const storage = {
      put: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      signedGetUrl: jest.fn().mockResolvedValue('https://storage.test/signed'),
    };
    const service = new PhotosService(repository as never, processor as never, storage as never);

    await expect(service.upload(USER_ID, {
      filename: 'portrait.jpeg', mimetype: 'image/jpeg', body: Buffer.from('source'),
    })).resolves.toBe('https://storage.test/signed');

    expect(storage.put).toHaveBeenCalledWith({
      key: KEY,
      body: webp,
      contentType: 'image/webp',
      cacheControl: 'private, max-age=300',
    });
    expect(repository.nextKey).toBe(KEY);
    expect(storage.signedGetUrl).toHaveBeenCalledWith(KEY, 300);
  });

  it('removes the object and clears its key when a photo is deleted', async () => {
    const repository = lockedRepository(KEY);
    const storage = {
      put: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
      signedGetUrl: jest.fn(),
    };
    const service = new PhotosService(repository as never, {} as never, storage as never);

    await expect(service.delete(USER_ID)).resolves.toBeUndefined();

    expect(storage.delete).toHaveBeenCalledWith(KEY);
    expect(repository.nextKey).toBeNull();
  });

  it('maps invalid image data to the stable API error contract', async () => {
    const processor = { toWebp: jest.fn().mockRejectedValue(new InvalidPhotoError()) };
    const service = new PhotosService({} as never, processor as never, {} as never);

    await expect(service.upload(USER_ID, {
      filename: 'portrait.jpg', mimetype: 'image/jpeg', body: Buffer.from('invalid'),
    })).rejects.toEqual(expect.objectContaining({ status: 400, code: 'invalid_photo' }));
  });

  it('maps unavailable object storage to a stable 503 response', async () => {
    const repository = lockedRepository(null);
    const processor = { toWebp: jest.fn().mockResolvedValue(Buffer.from('webp')) };
    const storage = {
      put: jest.fn().mockRejectedValue(new ObjectStorageUnavailableError(new Error('offline'))),
      delete: jest.fn(),
      signedGetUrl: jest.fn(),
    };
    const service = new PhotosService(repository as never, processor as never, storage as never);

    await expect(service.upload(USER_ID, {
      filename: 'portrait.webp', mimetype: 'image/webp', body: Buffer.from('webp'),
    })).rejects.toEqual(expect.objectContaining({ status: 503, code: 'photo_storage_unavailable' }));
  });
});

function lockedRepository(currentKey: string | null): {
  withLockedPhoto: jest.Mock;
  nextKey: string | null | undefined;
} {
  const repository: { withLockedPhoto: jest.Mock; nextKey: string | null | undefined } = {
    nextKey: undefined,
    withLockedPhoto: jest.fn(),
  };
  repository.withLockedPhoto.mockImplementation(async (
    _userId: string,
    transition: (key: string | null) => Promise<string | null>,
  ) => {
    repository.nextKey = await transition(currentKey);
    return true;
  });
  return repository;
}
