import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { ConfigService } from '../config/config.service';
import { apiError } from '../common/api-error';

export type AssertActivity = () => void;

/** Session locks drain external writers without keeping an SQL transaction open. */
@Injectable()
export class AccountActivityService implements OnModuleDestroy {
  // Separate, bounded pool: a writer must still be able to use the main SQL pool.
  private readonly pool: Pool;
  private readonly logger = new Logger(AccountActivityService.name);

  constructor(config: ConfigService) {
    this.pool = new Pool({ ...config.postgres, max: 4, application_name: 'histae-account-activity' });
    this.pool.on('error', () => this.logger.warn('account_activity_idle_connection_failed'));
  }

  async onModuleDestroy(): Promise<void> { await this.pool.end(); }

  async run<T>(userIds: string[], work: (assertHeld: AssertActivity) => Promise<T>): Promise<T> {
    const accountIds = canonicalIds(userIds);
    const result = await this.lock(accountIds, false, async (assertHeld, client) => {
      const accounts = await client.query(`
        SELECT user_id FROM user_account WHERE user_id = ANY($1::uuid[])
          AND deleted_at IS NULL AND NOT is_banned
      `, [accountIds]);
      if (accounts.rowCount !== accountIds.length) {
        throw apiError(409, 'account_unavailable', 'An account is no longer available.');
      }
      return work(assertHeld);
    });
    return result.value!;
  }

  tryExclusive<T>(userId: string, work: (assertHeld: AssertActivity) => Promise<T>) {
    return this.lock([userId], true, work);
  }

  private async lock<T>(
    userIds: string[], exclusive: boolean,
    work: (assertHeld: AssertActivity, client: import('pg').PoolClient) => Promise<T>,
  ): Promise<{ acquired: boolean; value?: T }> {
    const client = await this.pool.connect();
    let failed = false;
    const onError = () => { failed = true; };
    client.on('error', onError);
    const assertHeld = () => {
      if (failed) throw apiError(503, 'account_activity_unavailable', 'The account operation could not be verified.');
    };
    try {
      for (const id of canonicalIds(userIds)) {
        const locked = await client.query<{ acquired: boolean }>(exclusive
          ? 'SELECT pg_try_advisory_lock(hashtextextended($1, 13092026)) AS acquired'
          : 'SELECT pg_try_advisory_lock_shared(hashtextextended($1, 13092026)) AS acquired', [id]);
        if (!locked.rows[0]?.acquired) {
          if (exclusive) return { acquired: false };
          throw apiError(409, 'account_unavailable', 'An account operation is already in progress.');
        }
      }
      const value = await work(assertHeld, client);
      assertHeld();
      return { acquired: true, value };
    } finally {
      if (!failed) {
        try { await client.query('SELECT pg_advisory_unlock_all()'); }
        catch { failed = true; }
      }
      client.removeListener('error', onError);
      client.release(failed);
    }
  }
}

function canonicalIds(ids: string[]): string[] {
  // PostgreSQL/Scylla UUID values are case-insensitive; their advisory-lock keys
  // must have exactly the same identity semantics as the protected records.
  return [...new Set(ids.map((id) => id.toLowerCase()))].sort();
}
