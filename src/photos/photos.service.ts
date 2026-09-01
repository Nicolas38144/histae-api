import { Injectable } from '@nestjs/common';
import { apiError } from '../common/api-error';
import { ObjectStorageService, ObjectStorageUnavailableError } from '../storage/object-storage.service';
import { InvalidPhotoError, PhotoProcessorService, PhotoTooLargeError, type UploadedPhoto } from './photo-processor.service';
import { PhotosRepository } from './photos.repository';

const SIGNED_PHOTO_TTL_SECONDS = 5 * 60;
const PHOTO_KEY_PATTERN = /^profile-photos\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/photo\.webp$/;

@Injectable()
export class PhotosService {
  constructor(
    private readonly photos: PhotosRepository,
    private readonly processor: PhotoProcessorService,
    private readonly storage: ObjectStorageService,
  ) {}

  async upload(userId: string, upload: UploadedPhoto): Promise<string> {
    let webp: Buffer;
    try {
      webp = await this.processor.toWebp(upload);
    } catch (error) {
      if (error instanceof PhotoTooLargeError) throw apiError(413, 'photo_too_large', 'The photo exceeds the allowed size.');
      if (error instanceof InvalidPhotoError) throw apiError(400, 'invalid_photo', error.message);
      throw error;
    }

    const key = profilePhotoKey(userId);
    const updated = await this.photos.withLockedPhoto(userId, async () => {
      await this.storageCall(this.storage.put({
        key,
        body: webp,
        contentType: 'image/webp',
        cacheControl: 'private, max-age=300',
      }));
      return key;
    });
    if (!updated) {
      await this.storageCall(this.storage.delete(key));
      throw apiError(404, 'profile_not_found', 'The profile must be completed before adding a photo.');
    }
    return this.storageCall(this.storage.signedGetUrl(key, SIGNED_PHOTO_TTL_SECONDS));
  }

  async delete(userId: string): Promise<void> {
    const updated = await this.deleteLocked(userId);
    if (!updated) throw apiError(404, 'profile_not_found', 'The profile could not be found.');
  }

  async deleteForAccount(userId: string): Promise<void> {
    await this.deleteLocked(userId);
  }

  async urlForKey(key: string | null): Promise<string | null> {
    if (key === null || !PHOTO_KEY_PATTERN.test(key)) return null;
    return this.storageCall(this.storage.signedGetUrl(key, SIGNED_PHOTO_TTL_SECONDS));
  }

  private async deleteLocked(userId: string): Promise<boolean> {
    return this.photos.withLockedPhoto(userId, async (currentKey) => {
      if (currentKey !== null && PHOTO_KEY_PATTERN.test(currentKey)) {
        await this.storageCall(this.storage.delete(currentKey));
      }
      return null;
    });
  }

  private async storageCall<T>(operation: Promise<T>): Promise<T> {
    try {
      return await operation;
    } catch (error) {
      if (error instanceof ObjectStorageUnavailableError) {
        throw apiError(503, 'photo_storage_unavailable', 'Photo storage is temporarily unavailable.', error);
      }
      throw error;
    }
  }
}

export function profilePhotoKey(userId: string): string {
  return `profile-photos/${userId}/photo.webp`;
}
