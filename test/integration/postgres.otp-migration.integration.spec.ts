import { randomUUID } from 'node:crypto';
import { loadMigration, migrations } from '../../scripts/migration-catalog';
import { OtpRepository } from '../../src/auth/otp.repository';
import { IsolatedPostgres } from '../helpers/isolated-postgres';

describe('Sweego migration from existing OTP attempts', () => {
  const fixture = new IsolatedPostgres();
  beforeAll(() => fixture.start('013_resumable_account_erasure'), 60_000);
  afterAll(() => fixture.stop());

  it('preserves consumption, orders legacy attempts chronologically and advances the sequence for new attempts', async () => {
    const newerId = randomUUID(), olderId = randomUUID(), phoneHash = `migration-${randomUUID()}`;
    // Insert in reverse chronological order to detect accidental heap-order backfills.
    await fixture.pool.query(`INSERT INTO otp_verification
      (id,phone_number_hash,otp_hash,expires_at,delivery_status,used,created_at,sent_at)
      VALUES ($1,$3,'new-code',clock_timestamp()+interval '10 minutes','sent',true,clock_timestamp()-interval '10 seconds',clock_timestamp()),
        ($2,$3,'old-code',clock_timestamp()+interval '10 minutes','pending',false,clock_timestamp()-interval '20 seconds',NULL)`,
    [newerId, olderId, phoneHash]);
    const migration = migrations.find(item => item.version === '014_sweego_delivery_tracking')!;
    await fixture.database.transaction(async client => { await client.query((await loadMigration(migration)).sql); });
    const rows = (await fixture.pool.query('SELECT id, delivery_status, used, attempt_number FROM otp_verification ORDER BY attempt_number')).rows;
    expect(rows.map(row => row.id)).toEqual([olderId, newerId]);
    expect(rows[1]).toMatchObject({ delivery_status: 'accepted', used: true });
    const repository = new OtpRepository(fixture.database);
    await repository.applySmsEvent({ deliveryId: olderId, messageId: 'older-message', type: 'sms_sent' });
    expect(await repository.consumeOtp(phoneHash, 'old-code')).toBe(false);
    const newId = randomUUID();
    await repository.beginOtpDelivery({ id: newId, phoneHash, otpHash: 'future-code', idempotencyKey: randomUUID(), ttlMillis: 600_000, settlementMillis: 15_000 });
    const number = (await fixture.pool.query('SELECT attempt_number FROM otp_verification WHERE id = $1', [newId])).rows[0].attempt_number;
    expect(Number(number)).toBeGreaterThan(Number(rows[1].attempt_number));
  });
});
