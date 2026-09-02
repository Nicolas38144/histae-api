import { Injectable } from '@nestjs/common';
import { DatabaseService, type Queryable } from '../database/database.service';
import { OutboxRepository } from '../outbox/outbox.repository';

export const PHOTO_STATUSES = ['pending', 'processing', 'ready', 'deleting'] as const;
export type PhotoStatus = typeof PHOTO_STATUSES[number];

export type PhotoObject = {
  id: string;
  userId: string;
  objectKey: string;
  status: PhotoStatus;
};

export type ProcessingPhoto = {
  id: string;
  userId: string;
  objectKey: string;
  idempotencyKey: string;
  requestSha256: Buffer;
  createdAt: Date;
  expiresAt: Date;
};

export type PhotoMetadata = {
  mimeType: 'image/webp';
  sizeBytes: number;
  width: number;
  height: number;
  sha256: Buffer;
};

export type PhotoCreationResult =
  | { state: 'created' }
  | { state: 'replay'; photo: PhotoObject }
  | { state: 'profile_not_found' }
  | { state: 'update_in_progress' }
  | { state: 'idempotency_conflict' }
  | { state: 'idempotency_consumed' };

type UploadRequest = {
  requestSha256: Buffer;
  requestStatus: 'processing' | 'completed' | 'consumed';
  photoId: string | null;
  userId: string | null;
  objectKey: string | null;
  photoStatus: PhotoStatus | null;
};

@Injectable()
export class PhotosRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: OutboxRepository,
  ) {}

  async createProcessing(photo: ProcessingPhoto): Promise<PhotoCreationResult> {
    return this.database.transaction(async (client) => {
      if (!await this.lockActiveProfile(client, photo.userId)) {
        return { state: 'profile_not_found' };
      }

      await client.query(`
        DELETE FROM photo_upload_request
        WHERE user_id = $1 AND idempotency_key = $2 AND expires_at <= $3
      `, [photo.userId, photo.idempotencyKey, photo.createdAt]);

      const previousRequest = await client.query<UploadRequest>(`
        SELECT request.request_sha256 AS "requestSha256",
          request.status AS "requestStatus", request.photo_id AS "photoId",
          candidate.user_id AS "userId", candidate.object_key AS "objectKey",
          candidate.status AS "photoStatus"
        FROM photo_upload_request AS request
        LEFT JOIN user_photo AS candidate ON candidate.id = request.photo_id
        WHERE request.user_id = $1 AND request.idempotency_key = $2
      `, [photo.userId, photo.idempotencyKey]);
      const previousResult = creationResultForExistingRequest(
        previousRequest.rows[0],
        photo,
      );
      if (previousResult) return previousResult;

      const activeUpload = await client.query(`
        SELECT 1 FROM user_photo
        WHERE user_id = $1 AND status IN ('pending', 'processing')
        LIMIT 1
      `, [photo.userId]);
      if (activeUpload.rows[0]) return { state: 'update_in_progress' };

      await client.query(`
        INSERT INTO user_photo (id, user_id, object_key, status)
        VALUES ($1, $2, $3, 'processing')
      `, [photo.id, photo.userId, photo.objectKey]);
      await client.query(`
        INSERT INTO photo_upload_request (
          user_id, idempotency_key, request_sha256, photo_id, status,
          created_at, updated_at, expires_at
        ) VALUES ($1, $2, $3, $4, 'processing', $5, $5, $6)
      `, [
        photo.userId,
        photo.idempotencyKey,
        photo.requestSha256,
        photo.id,
        photo.createdAt,
        photo.expiresAt,
      ]);
      return { state: 'created' };
    });
  }

  async recordProcessed(photoId: string, userId: string, metadata: PhotoMetadata): Promise<boolean> {
    const result = await this.database.query(`
      UPDATE user_photo
      SET mime_type = $3, size_bytes = $4, width = $5, height = $6, sha256 = $7, updated_at = clock_timestamp()
      WHERE id = $1 AND user_id = $2 AND status = 'processing'
    `, [
      photoId,
      userId,
      metadata.mimeType,
      metadata.sizeBytes,
      metadata.width,
      metadata.height,
      metadata.sha256,
    ]);
    return result.rowCount === 1;
  }

  async activate(photoId: string, userId: string): Promise<boolean> {
    return this.database.transaction(async (client) => {
      if (!await this.lockActiveProfile(client, userId)) {
        return false;
      }

      const candidate = await client.query(`
        SELECT 1 FROM user_photo
        WHERE id = $1 AND user_id = $2 AND status = 'processing'
          AND mime_type IS NOT NULL AND size_bytes IS NOT NULL AND width IS NOT NULL
          AND height IS NOT NULL AND sha256 IS NOT NULL
        FOR UPDATE
      `, [photoId, userId]);
      if (!candidate.rows[0]) return false;

      const previous = await client.query<PhotoObject>(`
        UPDATE user_photo
        SET status = 'deleting', updated_at = clock_timestamp()
        WHERE user_id = $1 AND status = 'ready'
        RETURNING id, user_id AS "userId", object_key AS "objectKey", status
      `, [userId]);
      for (const photo of previous.rows) {
        await this.enqueueDeletion(client, photo.id);
      }
      const activated = await client.query(`
        UPDATE user_photo
        SET status = 'ready', updated_at = clock_timestamp()
        WHERE id = $1 AND user_id = $2 AND status = 'processing'
      `, [photoId, userId]);
      if (activated.rowCount !== 1) {
        throw new Error('Photo activation invariant violated');
      }

      const completedRequest = await client.query(`
        UPDATE photo_upload_request
        SET status = 'completed', updated_at = clock_timestamp()
        WHERE user_id = $1 AND photo_id = $2 AND status = 'processing'
      `, [userId, photoId]);
      if (completedRequest.rowCount !== 1) {
        throw new Error('Photo idempotency invariant violated');
      }
      return true;
    });
  }

  async beginDelete(userId: string): Promise<boolean> {
    return this.database.transaction(async (client) => {
      if (!await this.lockActiveProfile(client, userId)) {
        return false;
      }

      const deleted = await client.query<{ id: string }>(`
        UPDATE user_photo
        SET status = 'deleting', updated_at = clock_timestamp()
        WHERE user_id = $1 AND status = 'ready'
        RETURNING id
      `, [userId]);
      const photoId = deleted.rows[0]?.id;
      if (photoId) await this.enqueueDeletion(client, photoId);
      return true;
    });
  }

  async beginAccountDeletion(userId: string): Promise<PhotoObject[]> {
    return (await this.database.query<PhotoObject>(`
      UPDATE user_photo
      SET status = 'deleting', updated_at = clock_timestamp()
      WHERE user_id = $1
      RETURNING id, user_id AS "userId", object_key AS "objectKey", status
    `, [userId])).rows;
  }

  async completeDeletion(photoId: string): Promise<void> {
    await this.database.transaction(async (client) => {
      await client.query(`
        UPDATE photo_upload_request
        SET status = 'consumed', photo_id = NULL,
          updated_at = clock_timestamp()
        WHERE photo_id = $1
      `, [photoId]);
      await client.query(
        'DELETE FROM user_photo WHERE id = $1 AND status = \'deleting\'',
        [photoId],
      );
    });
  }

  async discardProcessing(photoId: string, userId: string): Promise<void> {
    await this.database.transaction(async (client) => {
      await client.query(`
        DELETE FROM photo_upload_request
        WHERE user_id = $1 AND photo_id = $2 AND status = 'processing'
      `, [userId, photoId]);
      await client.query(`
        DELETE FROM user_photo
        WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'processing')
      `, [photoId, userId]);
    });
  }

  async findDeleting(photoId: string): Promise<PhotoObject | undefined> {
    return (await this.database.query<PhotoObject>(`
      SELECT id, user_id AS "userId", object_key AS "objectKey", status
      FROM user_photo
      WHERE id = $1 AND status = 'deleting'
    `, [photoId])).rows[0];
  }

  async purgeExpiredUploadRequests(before: Date, limit: number): Promise<number> {
    const result = await this.database.query(`
      DELETE FROM photo_upload_request
      WHERE (user_id, idempotency_key) IN (
        SELECT user_id, idempotency_key
        FROM photo_upload_request
        WHERE expires_at <= $1
        ORDER BY expires_at, user_id, idempotency_key
        LIMIT $2
      )
    `, [before, limit]);
    return result.rowCount ?? 0;
  }

  async claimCleanupBatch(now: Date, staleBefore: Date, retryBefore: Date, limit: number): Promise<PhotoObject[]> {
    return (await this.database.query<PhotoObject>(`
      WITH candidates AS (
        SELECT id
        FROM user_photo
        WHERE (status IN ('pending', 'processing') AND updated_at <= $2)
           OR (status = 'deleting' AND updated_at <= $3)
        ORDER BY updated_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT $4
      )
      UPDATE user_photo AS photo
      SET status = 'deleting', updated_at = $1
      FROM candidates
      WHERE photo.id = candidates.id
      RETURNING photo.id, photo.user_id AS "userId",
        photo.object_key AS "objectKey", photo.status
    `, [now, staleBefore, retryBefore, limit])).rows;
  }

  private async lockActiveProfile(
    database: Queryable,
    userId: string,
  ): Promise<boolean> {
    const profile = await database.query(`
      SELECT profile.user_id
      FROM user_profile AS profile
      JOIN user_account AS account ON account.user_id = profile.user_id
      WHERE profile.user_id = $1 AND account.deleted_at IS NULL
      FOR UPDATE OF profile
    `, [userId]);
    return profile.rows.length > 0;
  }

  private async enqueueDeletion(
    database: Queryable,
    photoId: string,
  ): Promise<void> {
    await this.outbox.enqueue(database, {
      eventType: 'photo.delete',
      aggregateId: photoId,
    });
  }
}

function creationResultForExistingRequest(
  request: UploadRequest | undefined,
  photo: ProcessingPhoto,
): PhotoCreationResult | undefined {
  if (!request) return undefined;
  if (!request.requestSha256.equals(photo.requestSha256)) {
    return { state: 'idempotency_conflict' };
  }
  if (request.requestStatus === 'processing') {
    return { state: 'update_in_progress' };
  }
  if (request.requestStatus === 'completed'
    && request.photoId && request.userId === photo.userId && request.objectKey
    && request.photoStatus === 'ready') {
    return {
      state: 'replay',
      photo: {
        id: request.photoId,
        userId: request.userId,
        objectKey: request.objectKey,
        status: request.photoStatus,
      },
    };
  }
  return { state: 'idempotency_consumed' };
}
