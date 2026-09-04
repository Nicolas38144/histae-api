import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { Account } from './auth.models';

type CreateAccountInput = { userId: string; phoneHash: string; encryptedPhone: Buffer };

@Injectable()
export class AuthRepository {
  constructor(private readonly database: DatabaseService) {}

  async findAccountByPhoneHash(phoneHash: string): Promise<Account | undefined> {
    return (await this.database.query<Account>(`
      SELECT user_id, role, is_banned FROM user_account WHERE phone_number_hash = $1 AND deleted_at IS NULL
    `, [phoneHash])).rows[0];
  }

  async createAccount(account: CreateAccountInput): Promise<Account> {
    return this.database.transaction(async (client) => {
      const tombstone = await client.query<{ blocked: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM account_tombstone
          WHERE phone_number_hash = $1 AND expires_at > clock_timestamp()
        ) AS blocked
      `, [account.phoneHash]);
      if (tombstone.rows[0]?.blocked) throw new AccountTombstoneError();
      await client.query(`
        INSERT INTO user_account (user_id, role, phone_number_hash, phone_number_encrypted)
        VALUES ($1, 'user', $2, $3)
      `, [account.userId, account.phoneHash, account.encryptedPhone]);
      return { user_id: account.userId, role: 'user', is_banned: false };
    });
  }

}

export class AccountTombstoneError extends Error {
  constructor() {
    super('account tombstone is active');
  }
}
