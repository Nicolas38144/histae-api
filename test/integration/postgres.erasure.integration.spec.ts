import * as dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { loadMigration, migrations } from '../../scripts/migration-catalog';
import { DatabaseService } from '../../src/database/database.service';
import { AccountActivityService } from '../../src/database/account-activity.service';
import { UsersRepository } from '../../src/users/users.repository';
import { PrivacyRepository } from '../../src/privacy/privacy.repository';
import { ErasureRepository } from '../../src/privacy/erasure.repository';
import { ErasureService } from '../../src/privacy/erasure.service';
import { PhotosRepository } from '../../src/photos/photos.repository';
import { PhotosService } from '../../src/photos/photos.service';
import { OutboxRepository } from '../../src/outbox/outbox.repository';
import { OutboxWorkerService } from '../../src/outbox/outbox-worker.service';
import { MatchesRepository } from '../../src/matches/matches.repository';
import { MatchMessageRepository } from '../../src/matches/match-message.repository';
import { BillingRepository, BillingAccountInactiveError } from '../../src/billing/billing.repository';

dotenv.config();
if (process.env.ENV !== 'development' || process.env.POSTGRES_DB !== 'histae-dev'
  || !['localhost', '127.0.0.1', '::1'].includes(process.env.POSTGRES_HOST ?? '')) {
  throw new Error('Erasure integration tests require local development PostgreSQL histae-dev.');
}
const postgres = {
  host: process.env.POSTGRES_HOST, port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER, password: process.env.POSTGRES_PASSWORD, database: process.env.POSTGRES_DB,
  ssl: process.env.POSTGRES_SSLMODE !== 'disable',
};

describe('PostgreSQL resumable account erasure', () => {
  const schema = `erasure_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool(postgres);
  const isolated = { ...postgres, options: `-c search_path=${schema},public`, application_name: 'histae-erasure-test' };
  const pool = new Pool(isolated);
  const database = new DatabaseService({ postgres: isolated } as never);
  const activity = new AccountActivityService({ postgres: isolated } as never);
  const users = new UsersRepository(database);
  const privacy = new PrivacyRepository(database);
  const erasures = new ErasureRepository(database);
  const outbox = new OutboxRepository(database);
  const photosRepository = new PhotosRepository(database, outbox);
  const objects = new Set<string>();
  const calls: string[] = [];
  const stripe = { deleteCustomerForAccount: jest.fn<Promise<boolean>, [string]>() };
  const storage = { delete: jest.fn<Promise<void>, [string]>() };
  const scylla = { deleteUserDataBatch: jest.fn<Promise<boolean>, [string, number]>() };
  const photos = new PhotosService(photosRepository, {} as never, storage as never, activity);
  let createdSchema = false;
  let owner: string;
  let operator: string;

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    createdSchema = true;
    for (const migration of migrations) {
      await database.transaction(async (client) => { await client.query((await loadMigration(migration)).sql); });
    }
  }, 60_000);

  beforeEach(async () => {
    calls.length = 0;
    objects.clear();
    owner = await account();
    operator = await account('admin');
    await pool.query("INSERT INTO user_profile (user_id, firstname, birthdate) VALUES ($1, 'Private', '1990-01-01')", [owner]);
    stripe.deleteCustomerForAccount.mockReset().mockImplementation(async () => { await noOpenTransaction(); calls.push('stripe'); return true; });
    storage.delete.mockReset().mockImplementation(async (key) => { await noOpenTransaction(); calls.push('photos'); objects.delete(key); });
    scylla.deleteUserDataBatch.mockReset().mockImplementation(async (_user, partition) => { await noOpenTransaction(); calls.push(`scylla:${partition}`); return true; });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    expect((await pool.query('SELECT current_schema() AS name')).rows[0].name).toBe(schema);
    await pool.query('DELETE FROM match_init');
    await pool.query('DELETE FROM outbox_event');
    await pool.query('DELETE FROM user_account');
  });

  afterAll(async () => {
    await activity.onModuleDestroy();
    await database.onModuleDestroy();
    await pool.end();
    if (createdSchema && /^erasure_test_[a-f0-9]{32}$/.test(schema)) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  async function account(role = 'user') {
    const id = randomUUID();
    await pool.query(`INSERT INTO user_account (user_id, role, phone_number_hash, phone_number_encrypted)
      VALUES ($1, $2, $3, $4)`, [id, role, `test-${id}`, Buffer.alloc(0)]);
    return id;
  }

  async function photo() {
    const id = randomUUID();
    const key = `profile-photos/${owner}/${id}.webp`;
    await pool.query(`INSERT INTO user_photo (id, user_id, object_key, status, mime_type, size_bytes, width, height, sha256)
      VALUES ($1, $2, $3, 'ready', 'image/webp', 100, 10, 10, $4)`, [id, owner, key, Buffer.alloc(32)]);
    objects.add(key);
    return { id, key };
  }

  async function accept() {
    const token = randomUUID();
    await users.replaceDeletionToken(owner, token, 'test-hash', new Date(Date.now() + 60_000));
    const accepted = await users.acceptErasure(owner, token, 'test-hash', new Date());
    expect(accepted?.status).toBe('in_progress');
    return accepted!.request_id;
  }

  function worker(repository = erasures) {
    const service = new ErasureService(repository, activity, stripe as never, photos, scylla as never);
    return new OutboxWorkerService(outbox, photosRepository, storage as never, { maintenanceMode: 'disabled' } as never,
      {} as never, { deliver: jest.fn() } as never, service);
  }

  async function tick(instance = worker()) {
    await pool.query("UPDATE outbox_event SET available_at = now() - interval '1 second' WHERE status = 'pending'");
    return instance.runOnce();
  }

  async function state() {
    return (await pool.query(`SELECT erasure.*, request.status AS request_status, event.status AS event_status,
      event.id AS event_id, event.attempts, event.last_error_code, account.deleted_at, account.anonymized_at
      FROM account_erasure erasure JOIN data_subject_request request ON request.id = erasure.request_id
      JOIN outbox_event event ON event.aggregate_id = request.id AND event.event_type = 'account.erase'
      JOIN user_account account ON account.user_id = erasure.user_id WHERE erasure.user_id = $1`, [owner])).rows[0];
  }

  async function noOpenTransaction() {
    const result = await pool.query(`SELECT count(*)::integer AS count FROM pg_stat_activity
      WHERE datname = current_database() AND application_name IN ('histae-erasure-test', 'histae-account-activity')
        AND pid <> pg_backend_pid() AND xact_start IS NOT NULL`);
    expect(result.rows[0].count).toBe(0);
  }

  it('atomically freezes the account, consumes the token and enqueues exactly one request', async () => {
    const token = randomUUID();
    await users.replaceDeletionToken(owner, token, 'test-hash', new Date(Date.now() + 60_000));
    const results = await Promise.all(Array.from({ length: 3 }, () => users.acceptErasure(owner, token, 'test-hash', new Date())));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await state()).toMatchObject({ step: 'stripe', request_status: 'in_progress', event_status: 'pending', anonymized_at: null });
    expect((await state()).deleted_at).toBeInstanceOf(Date);
    expect((await pool.query('SELECT * FROM account_deletion_token WHERE user_id = $1', [owner])).rows).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it('rolls back token consumption and account freeze if enqueue fails', async () => {
    const token = randomUUID();
    await users.replaceDeletionToken(owner, token, 'test-hash', new Date(Date.now() + 60_000));
    const query = database.transaction.bind(database);
    const broken = { transaction: (work: Parameters<DatabaseService['transaction']>[0]) => query(async (client) => {
      const original = client.query.bind(client);
      jest.spyOn(client, 'query').mockImplementation(((sql: string, values?: unknown[]) => {
        if (sql.includes('INSERT INTO outbox_event')) throw new Error('simulated enqueue failure');
        return original(sql, values);
      }) as never);
      try { return await work(client); } finally { jest.restoreAllMocks(); }
    }) };
    await expect(new UsersRepository(broken as never).acceptErasure(owner, token, 'test-hash', new Date())).rejects.toThrow('simulated');
    expect((await pool.query('SELECT deleted_at FROM user_account WHERE user_id = $1', [owner])).rows[0].deleted_at).toBeNull();
    expect((await pool.query('SELECT id FROM account_deletion_token WHERE id = $1', [token])).rowCount).toBe(1);
    expect((await pool.query('SELECT * FROM account_erasure')).rows).toHaveLength(0);
  });

  it('checkpoints Stripe, photos and all 64 Scylla partitions before final SQL redaction', async () => {
    await photo();
    const requestId = await accept();
    // Recreate the worker for each tick to exercise recovery without in-memory progress.
    for (let i = 0; i < 67; i++) await tick();
    expect(calls).toEqual(['stripe', 'photos', ...Array.from({ length: 64 }, (_, i) => `scylla:${i}`)]);
    expect(objects.size).toBe(0);
    expect(await state()).toMatchObject({ step: 'completed', request_status: 'completed', event_status: 'completed' });
    expect((await pool.query('SELECT * FROM user_profile WHERE user_id = $1', [owner])).rows).toHaveLength(0);
    expect((await pool.query("SELECT * FROM data_access_log WHERE accessed_user_id = $1 AND action = 'system_anonymize'", [owner])).rowCount).toBe(1);
    expect((await privacy.requestsForAdmin(undefined)).find((row) => row.id === requestId)?.erasure?.step).toBe('completed');
  }, 30_000);

  it.each(['stripe', 'photos', 'scylla'] as const)('retries %s after an effect succeeds but its checkpoint is lost', async (step) => {
    await accept();
    await pool.query('UPDATE account_erasure SET step = $2 WHERE user_id = $1', [owner, step]);
    jest.spyOn(erasures, 'advance').mockRejectedValueOnce(new Error('private database detail'));
    expect((await tick()).retried).toBe(1);
    expect(await state()).toMatchObject({ step, request_status: 'in_progress', last_error_code: `erasure_${step}_unavailable` });
    expect((await tick()).deferred).toBe(1);
    const expected = step === 'stripe' ? 'photos' : step === 'photos' ? 'scylla' : 'scylla';
    expect((await state()).step).toBe(expected);
    expect((await state()).attempts).toBe(0);
    if (step === 'scylla') expect(scylla.deleteUserDataBatch).toHaveBeenCalledTimes(2);
  });

  it('retains the photo trace after a lost S3 deletion response, then retries the same key', async () => {
    const { key, id } = await photo();
    await accept();
    await tick();
    storage.delete.mockImplementationOnce(async (objectKey) => { objects.delete(objectKey); throw new Error('lost response'); });
    expect((await tick()).retried).toBe(1);
    expect(objects.size).toBe(0);
    expect((await pool.query('SELECT status FROM user_photo WHERE id = $1', [id])).rows[0].status).toBe('deleting');
    await tick();
    expect(storage.delete.mock.calls.map(([objectKey]) => objectKey)).toEqual([key, key]);
    expect((await pool.query('SELECT * FROM user_photo WHERE id = $1', [id])).rows).toHaveLength(0);
    expect((await state()).step).toBe('scylla');
  });

  it('waits for an in-flight external writer without consuming the failure budget', async () => {
    const entered = barrier();
    const release = barrier();
    const writer = activity.run([owner], async () => { entered.resolve(); await release.promise; });
    try {
      await entered.promise;
      await accept();
      expect((await tick()).deferred).toBe(1);
      expect(calls).toEqual([]);
      expect((await state()).attempts).toBe(0);
      await expect(activity.run([owner], async () => undefined)).rejects.toMatchObject({ code: 'account_unavailable' });
    } finally { release.resolve(); await writer; }
    await tick();
    expect((await state()).step).toBe('photos');
  });

  it('prevents new shared writers while an erasure step owns its session lock', async () => {
    await activity.tryExclusive(owner, async () => {
      await expect(activity.run([owner], async () => undefined)).rejects.toMatchObject({ code: 'account_unavailable' });
      await expect(activity.run([owner.toUpperCase()], async () => undefined)).rejects.toMatchObject({ code: 'account_unavailable' });
    });
    await expect(activity.run([owner, owner.toUpperCase()], async () => 'ok')).resolves.toBe('ok');
  });

  it('waits for an actual in-flight photo PUT, then deletes its object and processing trace', async () => {
    const entered = barrier();
    const release = barrier();
    const uploadStorage = {
      put: jest.fn(async ({ key }: { key: string }) => { entered.resolve(); await release.promise; objects.add(key); }),
    };
    const processor = { toWebp: jest.fn().mockResolvedValue({ body: Buffer.alloc(100), mimeType: 'image/webp', sizeBytes: 100, width: 10, height: 10, sha256: Buffer.alloc(32) }) };
    const uploader = new PhotosService(photosRepository, processor as never, uploadStorage as never, activity);
    const uploading = uploader.upload(owner, { filename: 'photo.webp', mimetype: 'image/webp', body: Buffer.alloc(100) }, randomUUID());
    const rejected = expect(uploading).rejects.toMatchObject({ code: 'photo_update_conflict' });
    try {
      await entered.promise;
      await accept();
      await pool.query("UPDATE account_erasure SET step = 'photos' WHERE user_id = $1", [owner]);
      expect((await tick()).deferred).toBe(1);
      expect(storage.delete).not.toHaveBeenCalled();
    } finally { release.resolve(); await rejected; }
    expect(objects.size).toBe(1);
    await tick();
    expect(objects.size).toBe(0);
    expect((await pool.query('SELECT * FROM user_photo WHERE user_id = $1', [owner])).rows).toHaveLength(0);
  });

  it('allows staleness maintenance but cannot recreate or change a frozen location', async () => {
    await pool.query('INSERT INTO user_presence (user_id, latitude, longitude, is_location_fresh) VALUES ($1, 48, 2, true)', [owner]);
    await accept();
    await expect(pool.query('UPDATE user_presence SET is_location_fresh = false WHERE user_id = $1', [owner])).resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query('UPDATE user_presence SET latitude = 49 WHERE user_id = $1', [owner])).rejects.toMatchObject({ code: 'P0E01' });
    await expect(pool.query('UPDATE user_presence SET is_location_fresh = true WHERE user_id = $1', [owner])).rejects.toMatchObject({ code: 'P0E01' });
  });

  it('serializes account freeze after an already-started SQL profile mutation', async () => {
    const token = randomUUID();
    await users.replaceDeletionToken(owner, token, 'test-hash', new Date(Date.now() + 60_000));
    const writer = await pool.connect();
    let accepting: ReturnType<UsersRepository['acceptErasure']> | undefined;
    try {
      await writer.query('BEGIN');
      const pid = (await writer.query('SELECT pg_backend_pid() AS id')).rows[0].id as number;
      await writer.query("UPDATE user_profile SET bio = 'before freeze' WHERE user_id = $1", [owner]);
      accepting = users.acceptErasure(owner, token, 'test-hash', new Date());
      for (let attempt = 0; ; attempt++) {
        const waiting = (await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rowCount;
        if (waiting) break;
        if (attempt >= 200) throw new Error('Account freeze did not reach its SQL lock barrier');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect((await pool.query('SELECT * FROM account_erasure WHERE user_id = $1', [owner])).rowCount).toBe(0);
      await writer.query('COMMIT');
      await expect(accepting).resolves.toMatchObject({ status: 'in_progress' });
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
      await accepting;
    }
    await expect(pool.query("UPDATE user_profile SET bio = 'after freeze' WHERE user_id = $1", [owner])).rejects.toMatchObject({ code: 'P0E01' });
  });

  it.each([
    "UPDATE user_profile SET bio = 'late bio' WHERE user_id = $1",
    "INSERT INTO user_preferences (user_id, min_age, max_age, max_distance_km, looking_for) VALUES ($1, 18, 50, 20, 'both')",
    'INSERT INTO user_presence (user_id, latitude, longitude) VALUES ($1, 48, 2)',
    "INSERT INTO user_consent (user_id, consent_type, granted, document_version) VALUES ($1, 'location_consent', true, 'test')",
    "INSERT INTO billing_customer (user_id, stripe_customer_id) VALUES ($1, 'cus_Late')",
    "INSERT INTO user_subscription (user_id, plan) VALUES ($1, 'premium')",
    "INSERT INTO data_subject_request (user_id, type) VALUES ($1, 'access')",
  ])('rejects late account writes: %s', async (sql) => {
    await accept();
    await expect(pool.query(sql, [owner])).rejects.toMatchObject({ code: 'P0E01' });
  });

  it('hides pending-erasure matches and refuses messages before final anonymization', async () => {
    const matchId = randomUUID();
    const [first, second] = [owner, operator].sort();
    await pool.query(`INSERT INTO match_init (id, user1_id, user2_id, status, expires_at)
      VALUES ($1, $2, $3, 'active', now() + interval '1 day')`, [matchId, first, second]);
    await accept();
    expect(await new MatchesRepository(database).listForUser(operator, 20, 0)).toEqual([]);
    await expect(new MatchMessageRepository(database).createMessage(randomUUID(), matchId, operator, 'late', randomUUID()))
      .resolves.toEqual({ ok: false, reason: 'not_found' });
    await expect(pool.query('INSERT INTO chat_message (match_id, sender_id, content) VALUES ($1, $2, $3)', [matchId, operator, 'late']))
      .rejects.toMatchObject({ code: 'P0E01' });
  });

  it('schedules administrative erasure idempotently, without early completion or cancellation', async () => {
    const request = (await privacy.createRequest(owner, 'erasure'))!;
    await privacy.updateRequest(request.id, 'in_progress', operator, 'admin', null);
    expect(await privacy.updateRequest(request.id, 'completed', operator, 'admin', 'Identity verified')).toBe('erasure_scheduled');
    expect(await privacy.updateRequest(request.id, 'completed', operator, 'admin', 'Retry')).toBe('erasure_scheduled');
    expect(await privacy.updateRequest(request.id, 'rejected', operator, 'admin', 'Cancel')).toBe('invalid_transition');
    expect((await state()).request_status).toBe('in_progress');
    expect((await pool.query("SELECT * FROM outbox_event WHERE event_type = 'account.erase'")).rowCount).toBe(1);
    expect(calls).toEqual([]);
  });

  it('does not allow a stale claimant to checkpoint or finalize an erasure', async () => {
    await accept();
    const oldWorker = randomUUID();
    const claimed = (await outbox.claimBatch(oldWorker, new Date(Date.now() + 1000), new Date(0), 1))[0]!;
    const current = (await erasures.claimed(claimed.id, oldWorker))!;
    await pool.query('UPDATE outbox_event SET locked_by = $2 WHERE id = $1', [claimed.id, randomUUID()]);
    expect(await erasures.advance(claimed.id, oldWorker, current, 'photos')).toBe(false);
    expect((await state()).step).toBe('stripe');
  });

  it('refuses finalization while a photo trace remains and rolls back the completion marker', async () => {
    await photo();
    await accept();
    await pool.query("UPDATE account_erasure SET step = 'postgres', scylla_partition = 64 WHERE user_id = $1", [owner]);
    expect((await tick()).retried).toBe(1);
    expect(await state()).toMatchObject({ step: 'postgres', request_status: 'in_progress', anonymized_at: null, last_error_code: 'erasure_postgres_unavailable' });
    expect((await pool.query('SELECT * FROM user_profile WHERE user_id = $1', [owner])).rowCount).toBe(1);
  });

  it('does not repeat anonymization if its final outbox acknowledgement is lost', async () => {
    await accept();
    await pool.query("UPDATE account_erasure SET step = 'postgres', scylla_partition = 64 WHERE user_id = $1", [owner]);
    jest.spyOn(outbox, 'complete').mockRejectedValueOnce(new Error('lost ack'));
    expect((await tick()).retried).toBe(1);
    const completedAt = (await state()).completed_at;
    expect((await tick()).completed).toBe(1);
    expect((await state()).completed_at).toEqual(completedAt);
    expect((await pool.query("SELECT * FROM data_access_log WHERE accessed_user_id = $1 AND action = 'system_anonymize'", [owner])).rowCount).toBe(1);
  });

  it('moves failures to dead letter, forbids discard and supports audited retry without unfreezing', async () => {
    await accept();
    stripe.deleteCustomerForAccount.mockRejectedValue(new Error('secret customer payload'));
    for (let i = 0; i < 10; i++) await tick();
    const failed = await state();
    expect(failed).toMatchObject({ event_status: 'dead_letter', attempts: 10, last_error_code: 'erasure_stripe_unavailable', request_status: 'in_progress' });
    const actor = { userId: operator, role: 'admin' as const };
    expect(await outbox.discardDeadLetter(failed.event_id, actor, 'Do not abandon erasure')).toBe('discard_not_allowed');
    expect(await outbox.retryDeadLetter(failed.event_id, actor, 'Provider recovered')).toBe('updated');
    expect((await pool.query('SELECT * FROM outbox_operator_action WHERE outbox_event_id = $1', [failed.event_id])).rowCount).toBe(1);
    expect((await state()).deleted_at).toBeInstanceOf(Date);
    stripe.deleteCustomerForAccount.mockResolvedValue(true);
    await tick();
    expect((await state()).step).toBe('photos');
  });

  it('rejects Stripe projections for a frozen account without recreating its subscription', async () => {
    const billing = new BillingRepository(database);
    await billing.saveCustomer(owner, 'cus_Frozen');
    await accept();
    await expect(database.transaction((client) => billing.resolveBillingUser('cus_Frozen', owner, client)))
      .rejects.toBeInstanceOf(BillingAccountInactiveError);
    await expect(database.transaction((client) => billing.markCustomerDeleted('cus_Frozen', new Date(), client)))
      .rejects.toBeInstanceOf(BillingAccountInactiveError);
    expect((await pool.query('SELECT * FROM user_subscription WHERE user_id = $1', [owner])).rows).toEqual([]);
  });
});

function barrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
