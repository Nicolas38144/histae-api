import { createHash, randomUUID } from 'node:crypto';

import { Injectable, Logger, Optional } from '@nestjs/common';

import { apiError } from '../common/api-error';
import { AccountActivityService, type AssertActivity } from '../database/account-activity.service';
import { normalizeIdempotencyKey } from '../common/idempotency';
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
import { type PhotoObject, PhotosRepository } from './photos.repository';
import { PhotoModerationService } from '../moderation/photo-moderation.service';
import type { AutomatedPhotoModeration, ModerationReasonCode, ModerationStatus } from '../moderation/moderation.models';

export type UploadedPhotoResult = {
  photo: string;
  moderation_status: ModerationStatus;
  moderation_reasons: ModerationReasonCode[];
};

const PROFILE_PHOTO_TTL_SECONDS = 300;
const PHOTO_UPLOAD_IDEMPOTENCY_TTL_MILLIS = 24 * 60 * 60 * 1_000;
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
    private readonly activity: AccountActivityService,
    @Optional() private readonly moderation?: PhotoModerationService,
  ) {}

  async upload(
    userId: string,
    upload: UploadedPhoto,
    idempotencyInput: string | undefined,
  ): Promise<UploadedPhotoResult> {
    return this.activity.run([userId], (assertHeld) => this.uploadWhileActive(userId, upload, idempotencyInput, assertHeld));
  }

  private async uploadWhileActive(userId: string, upload: UploadedPhoto, idempotencyInput: string | undefined, assertHeld: AssertActivity): Promise<UploadedPhotoResult> {
    const idempotencyKey = normalizeIdempotencyKey(idempotencyInput);
    const photoId = randomUUID();
    const objectKey = this.profilePhotoKey(userId, photoId);
    const createdAt = new Date();
    const creation = await this.photosRepository.createProcessing({
      id: photoId,
      userId,
      objectKey,
      idempotencyKey,
      requestSha256: uploadRequestHash(upload),
      createdAt,
      expiresAt: new Date(
        createdAt.getTime() + PHOTO_UPLOAD_IDEMPOTENCY_TTL_MILLIS,
      ),
    });

    if (creation.state === 'profile_not_found') {
      throw apiError(404, 'profile_not_found', 'Profile not found');
    }

    if (creation.state === 'update_in_progress') {
      throw apiError(
        409,
        'photo_update_in_progress',
        'A profile photo update is already in progress',
      );
    }

    if (creation.state === 'idempotency_conflict') {
      throw apiError(
        409,
        'idempotency_key_conflict',
        'The Idempotency-Key has already been used for another photo',
      );
    }

    if (creation.state === 'idempotency_consumed') {
      throw apiError(
        409,
        'idempotency_key_consumed',
        'The result associated with this Idempotency-Key is no longer current',
      );
    }

    if (creation.state === 'replay') {
      return {
        photo: await this.signPhoto(creation.photo.objectKey),
        moderation_status: creation.photo.moderationStatus ?? 'pending',
        moderation_reasons: creation.photo.moderationReasons ?? ['analysis_unavailable'],
      };
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

    const moderation = this.moderation
      ? await this.moderation.analyze(processed.body)
      : manualPhotoModeration();

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
      assertHeld();
      await this.objectStorage.put({
        key: objectKey,
        body: processed.body,
        contentType: processed.mimeType,
        cacheControl: PROFILE_PHOTO_CACHE_CONTROL,
      });
    } catch (error: unknown) {
      this.throwStorageUnavailable(error, 'upload');
    }

    const activated = await this.photosRepository.activate(photoId, userId, moderation);
    if (!activated) {
      // The object may already exist. Maintenance will safely remove it.
      throw apiError(
        409,
        'photo_update_conflict',
        'The profile photo update could not be completed',
      );
    }

    return {
      photo: await this.signPhoto(objectKey),
      moderation_status: moderation.status,
      moderation_reasons: moderation.reasonCodes,
    };
  }

  async delete(userId: string): Promise<void> {
    if (!await this.photosRepository.beginDelete(userId)) {
      throw apiError(404, 'profile_not_found', 'Profile not found');
    }
  }

  async deleteForAccount(userId: string): Promise<boolean> {
    const batchSize = 50;
    const photos = await this.photosRepository.beginAccountDeletion(userId, batchSize);
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
    return photos.length < batchSize;
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

  private async removePhoto(photo: PhotoObject): Promise<void> {
    await this.objectStorage.delete(photo.objectKey);
    await this.photosRepository.completeDeletion(photo.id);
  }

  private profilePhotoKey(userId: string, photoId: string): string {
    return `profile-photos/${userId}/${photoId}.webp`;
  }

  private async signPhoto(objectKey: string): Promise<string> {
    try {
      return await this.objectStorage.signedGetUrl(
        objectKey,
        PROFILE_PHOTO_TTL_SECONDS,
      );
    } catch (error: unknown) {
      this.throwStorageUnavailable(error, 'sign');
    }
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

function uploadRequestHash(upload: UploadedPhoto): Buffer {
  const hash = createHash('sha256');
  updateLengthPrefixed(hash, Buffer.from(upload.filename, 'utf8'));
  updateLengthPrefixed(hash, Buffer.from(upload.mimetype.trim().toLowerCase(), 'utf8'));
  updateLengthPrefixed(hash, upload.body);
  return hash.digest();
}

function manualPhotoModeration(): AutomatedPhotoModeration {
  return {
    status: 'pending' as const,
    reasonCodes: ['analysis_unavailable'],
    policyVersion: 'local_vision_v1',
    faceCount: null,
    sharpnessScore: null,
    nsfwScore: null,
  };
}

function updateLengthPrefixed(
  hash: ReturnType<typeof createHash>,
  value: Buffer,
): void {
  const size = Buffer.allocUnsafe(4);
  size.writeUInt32BE(value.length);
  hash.update(size).update(value);
}
