import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export const PHOTO_STATUSES = ['pending', 'processing', 'ready', 'deleting'] as const;
export type PhotoStatus = typeof PHOTO_STATUSES[number];

export type PhotoObject = {
  id: string;
  user_id: string;
  object_key: string;
  status: PhotoStatus;
};

export type ProcessingPhoto = {
  id: string;
  userId: string;
  objectKey: string;
};

export type PhotoMetadata = {
  mimeType: 'image/webp';
  sizeBytes: number;
  width: number;
  height: number;
  sha256: Buffer;
};

type CreationResult = 'created' | 'profile_not_found' | 'update_in_progress';
type DeleteResult = { profileFound: boolean; photo?: PhotoObject };

@Injectable()
export class PhotosRepository {
  constructor(private readonly database: DatabaseService) {}

  async createProcessing(photo: ProcessingPhoto): Promise<CreationResult> {
    return this.database.transaction(async (client) => {
      const profile = await client.query<{ user_id: string }>(`
        SELECT profile.user_id
        FROM user_profile AS profile
        JOIN user_account AS account ON account.user_id = profile.user_id
        WHERE profile.user_id = $1 AND account.deleted_at IS NULL
        FOR UPDATE OF profile
      `, [photo.userId]);
      if (!profile.rows[0]) return 'profile_not_found';

      const activeUpload = await client.query(`
        SELECT 1 FROM user_photo
        WHERE user_id = $1 AND status IN ('pending', 'processing')
        LIMIT 1
      `, [photo.userId]);
      if (activeUpload.rows[0]) return 'update_in_progress';

      await client.query(`
        INSERT INTO user_photo (id, user_id, object_key, status)
        VALUES ($1, $2, $3, 'processing')
      `, [photo.id, photo.userId, photo.objectKey]);
      return 'created';
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

  async activate(photoId: string, userId: string): Promise<{ activated: boolean; previous: PhotoObject[] }> {
    return this.database.transaction(async (client) => {
      const profile = await client.query<{ user_id: string }>(`
        SELECT profile.user_id
        FROM user_profile AS profile
        JOIN user_account AS account ON account.user_id = profile.user_id
        WHERE profile.user_id = $1 AND account.deleted_at IS NULL
        FOR UPDATE OF profile
      `, [userId]);
      if (!profile.rows[0]) return { activated: false, previous: [] };

      const candidate = await client.query(`
        SELECT 1 FROM user_photo
        WHERE id = $1 AND user_id = $2 AND status = 'processing'
          AND mime_type IS NOT NULL AND size_bytes IS NOT NULL AND width IS NOT NULL
          AND height IS NOT NULL AND sha256 IS NOT NULL
        FOR UPDATE
      `, [photoId, userId]);
      if (!candidate.rows[0]) return { activated: false, previous: [] };

      const previous = await client.query<PhotoObject>(`
        UPDATE user_photo
        SET status = 'deleting', updated_at = clock_timestamp()
        WHERE user_id = $1 AND status = 'ready'
        RETURNING id, user_id, object_key, status
      `, [userId]);
      const activated = await client.query(`
        UPDATE user_photo
        SET status = 'ready', updated_at = clock_timestamp()
        WHERE id = $1 AND user_id = $2 AND status = 'processing'
      `, [photoId, userId]);
      return { activated: activated.rowCount === 1, previous: previous.rows };
    });
  }

  async beginDelete(userId: string): Promise<DeleteResult> {
    return this.database.transaction(async (client) => {
      const profile = await client.query<{ user_id: string }>(`
        SELECT profile.user_id
        FROM user_profile AS profile
        JOIN user_account AS account ON account.user_id = profile.user_id
        WHERE profile.user_id = $1 AND account.deleted_at IS NULL
        FOR UPDATE OF profile
      `, [userId]);
      if (!profile.rows[0]) return { profileFound: false };

      const deleted = await client.query<PhotoObject>(`
        UPDATE user_photo
        SET status = 'deleting', updated_at = clock_timestamp()
        WHERE user_id = $1 AND status = 'ready'
        RETURNING id, user_id, object_key, status
      `, [userId]);
      return { profileFound: true, photo: deleted.rows[0] };
    });
  }

  async beginAccountDeletion(userId: string): Promise<PhotoObject[]> {
    return (await this.database.query<PhotoObject>(`
      UPDATE user_photo
      SET status = 'deleting', updated_at = clock_timestamp()
      WHERE user_id = $1
      RETURNING id, user_id, object_key, status
    `, [userId])).rows;
  }

  async completeDeletion(photoId: string): Promise<void> {
    await this.database.query('DELETE FROM user_photo WHERE id = $1 AND status = \'deleting\'', [photoId]);
  }

  async discardProcessing(photoId: string, userId: string): Promise<void> {
    await this.database.query(`
      DELETE FROM user_photo
      WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'processing')
    `, [photoId, userId]);
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
      RETURNING photo.id, photo.user_id, photo.object_key, photo.status
    `, [now, staleBefore, retryBefore, limit])).rows;
  }
}
