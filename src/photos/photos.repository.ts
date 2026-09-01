import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class PhotosRepository {
  constructor(private readonly database: DatabaseService) {}

  async withLockedPhoto(
    userId: string,
    transition: (currentKey: string | null) => Promise<string | null>,
  ): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const profile = await client.query<{ photo: string | null }>(`
        SELECT profile.photo
        FROM user_profile AS profile
        JOIN user_account AS account ON account.user_id = profile.user_id
        WHERE profile.user_id = $1 AND account.deleted_at IS NULL
        FOR UPDATE OF profile
      `, [userId]);
      if (!profile.rows[0]) return false;
      const nextKey = await transition(profile.rows[0].photo);
      await client.query('UPDATE user_profile SET photo = $2 WHERE user_id = $1', [userId, nextKey]);
      return true;
    });
  }
}
