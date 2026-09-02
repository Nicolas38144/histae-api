import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { apiError } from '../common/api-error';
import {
  ObjectStorageService,
  ObjectStorageUnavailableError,
} from '../storage/object-storage.service';
import {
  InvalidPhotoError,
  PhotoProcessorService,
  PhotoTooLargeError,
  type ProcessedPhoto,
  type UploadedPhoto,
} from './photo-processor.service';
import { PhotoObject, PhotosRepository } from './photos.repository';

const PROFILE_PHOTO_TTL_SECONDS = 300;
const PROFILE_PHOTO_CACHE_CONTROL =
  `private, max-age=${PROFILE_PHOTO_TTL_SECONDS}`;
const PROFILE_PHOTO_KEY_PATTERN =
  /^profile-photos\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.webp$/i;

@Injectable()
export class PhotosService {
  private readonly logger = new Logger(PhotosService.name);

  constructor(
    private readonly photosRepository: PhotosRepository,
    private readonly photoProcessor: PhotoProcessorService,
    private readonly objectStorage: ObjectStorageService,
  ) {}

  async upload(userId: string, upload: UploadedPhoto): Promise<string> {
    const photoId = randomUUID();
    const objectKey = this.profilePhotoKey(userId, photoId);
    const creation = await this.photosRepository.createProcessing({
      id: photoId,
      userId,
      objectKey,
    });

    if (creation === 'profile_not_found') {
      throw apiError(404, 'profile_not_found', 'Profile not found');
    }

    if (creation === 'update_in_progress') {
      throw apiError(
        409,
        'photo_update_in_progress',
        'A profile photo update is already in progress',
      );
    }

    let processed: ProcessedPhoto;
    try {
      processed = await this.photoProcessor.toWebp(upload);
    } catch (error: unknown) {
      await this.photosRepository.discardProcessing(photoId, userId);

      if (error instanceof PhotoTooLargeError) {
        throw apiError(
          413,
          'photo_too_large',
          'The processed photo exceeds 500 kB',
        );
      }

      if (error instanceof InvalidPhotoError) {
        throw apiError(400, 'invalid_photo', error.message);
      }

      throw error;
    }

    const metadataRecorded = await this.photosRepository.recordProcessed(
      photoId,
      userId,
      {
        mimeType: processed.mimeType,
        sizeBytes: processed.sizeBytes,
        width: processed.width,
        height: processed.height,
        sha256: processed.sha256,
      },
    );

    if (!metadataRecorded) {
      await this.photosRepository.discardProcessing(photoId, userId);
      throw apiError(
        409,
        'photo_update_conflict',
        'The profile photo update could not be completed',
      );
    }

    try {
      await this.objectStorage.put({
        key: objectKey,
        body: processed.body,
        contentType: processed.mimeType,
        cacheControl: PROFILE_PHOTO_CACHE_CONTROL,
      });
    } catch (error: unknown) {
      this.throwStorageUnavailable(error, 'upload');
    }

    const activation = await this.photosRepository.activate(photoId, userId);
    if (!activation.activated) {
      // The object may already exist. Maintenance will safely remove it.
      throw apiError(
        409,
        'photo_update_conflict',
        'The profile photo update could not be completed',
      );
    }

    await this.cleanupPreviousPhotos(activation.previous);

    try {
      return await this.objectStorage.signedGetUrl(
        objectKey,
        PROFILE_PHOTO_TTL_SECONDS,
      );
    } catch (error: unknown) {
      this.throwStorageUnavailable(error, 'sign');
    }
  }

  async delete(userId: string): Promise<void> {
    const deletion = await this.photosRepository.beginDelete(userId);
    if (!deletion.profileFound) {
      throw apiError(404, 'profile_not_found', 'Profile not found');
    }

    if (!deletion.photo) {
      return;
    }

    try {
      await this.removePhoto(deletion.photo);
    } catch (error: unknown) {
      if (error instanceof ObjectStorageUnavailableError) {
        this.throwStorageUnavailable(error, 'delete');
      }
      throw error;
    }
  }

  async deleteForAccount(userId: string): Promise<void> {
    const photos = await this.photosRepository.beginAccountDeletion(userId);
    let failures = 0;

    for (const photo of photos) {
      try {
        await this.removePhoto(photo);
      } catch (error: unknown) {
        failures += 1;
        this.logPhotoOperationFailure(error, 'account deletion');
      }
    }

    if (failures > 0) {
      throw apiError(
        503,
        'data_erasure_unavailable',
        'The account data could not be completely erased',
      );
    }
  }

  async urlForKey(objectKey: string | null): Promise<string | null> {
    if (objectKey === null) {
      return null;
    }

    if (!PROFILE_PHOTO_KEY_PATTERN.test(objectKey)) {
      this.logger.warn('Refused to sign an invalid profile photo key');
      return null;
    }

    try {
      return await this.objectStorage.signedGetUrl(
        objectKey,
        PROFILE_PHOTO_TTL_SECONDS,
      );
    } catch (error: unknown) {
      this.throwStorageUnavailable(error, 'sign');
    }
  }

  private async cleanupPreviousPhotos(photos: PhotoObject[]): Promise<void> {
    for (const photo of photos) {
      try {
        await this.removePhoto(photo);
      } catch (error: unknown) {
        this.logPhotoOperationFailure(error, 'old photo cleanup');
      }
    }
  }

  private async removePhoto(photo: PhotoObject): Promise<void> {
    await this.objectStorage.delete(photo.objectKey);
    await this.photosRepository.completeDeletion(photo.id);
  }

  private profilePhotoKey(userId: string, photoId: string): string {
    return `profile-photos/${userId}/${photoId}.webp`;
  }

  private throwStorageUnavailable(error: unknown, operation: string): never {
    this.logPhotoOperationFailure(error, operation);
    throw apiError(
      503,
      'photo_storage_unavailable',
      'Photo storage is temporarily unavailable',
    );
  }

  private logPhotoOperationFailure(error: unknown, operation: string): void {
    if (error instanceof ObjectStorageUnavailableError) {
      this.logger.warn(`Photo storage ${operation} failed`);
      return;
    }

    this.logger.error(`Unexpected photo ${operation} failure`);
  }
}
