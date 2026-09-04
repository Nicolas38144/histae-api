import { randomUUID } from 'node:crypto';
import { IsolatedPostgres, deferred, eventually } from '../helpers/isolated-postgres';
import { MatchesRepository } from '../../src/matches/matches.repository';
import { MatchMaintenanceRepository } from '../../src/matches/match-maintenance.repository';
import { MatchMessageRepository } from '../../src/matches/match-message.repository';
import { UsersRepository } from '../../src/users/users.repository';
import { UsersService } from '../../src/users/users.service';
import { AuthRepository, AccountTombstoneError } from '../../src/auth/auth.repository';
import { PrivacyRepository } from '../../src/privacy/privacy.repository';
import { ReportsRepository } from '../../src/reports/reports.repository';
import { DiscoveryRepository } from '../../src/discovery/discovery.repository';
import type { ConsentType } from '../../src/users/users.models';
import type { KeysetCursor } from '../../src/common/pagination';

const legal = { termsVersion: 'v1', privacyVersion: 'v1', sensitiveDataConsentVersion: 'v1', locationConsentVersion: 'v1',
  termsUrl: '', privacyUrl: '', sensitiveDataConsentUrl: '', locationConsentUrl: '' };
const choices: ConsentType[] = ['terms_of_service_acceptance', 'privacy_notice_acknowledgement', 'sensitive_data_consent', 'location_consent'];

describe('PostgreSQL business concurrency and retention', () => {
  const fixture = new IsolatedPostgres();
  const { pool, database } = fixture;
  const matches = new MatchesRepository(database);
  const users = new UsersRepository(database);
  const service = new UsersService(users, { legal } as never, { urlForKey: async () => null } as never);
  const auth = new AuthRepository(database);
  const privacy = new PrivacyRepository(database);
  const discovery = new DiscoveryRepository(database);

  beforeAll(() => fixture.start(), 60_000);
  afterEach(async () => { jest.restoreAllMocks(); await fixture.reset(); });
  afterAll(() => fixture.stop());

  async function ready(id: string) {
    await users.recordConsents(id, choices.map(consent_type => ({ consent_type, granted: true, document_version: 'v1' })), '', '');
    await users.upsertPreferences(id, { min_age: 18, max_age: 99, max_distance_km: 50, looking_for: 'both' }, legal);
    await users.upsertPresence(id, { latitude: 48.85, longitude: 2.35 }, new Date(), legal);
  }

  it('serializes both continuation consents and charges the initiator exactly once', async () => {
    const [a, b] = await Promise.all([fixture.account(), fixture.account()]);
    const id = await fixture.match(a, b);
    const results = await Promise.all([matches.recordContinuationConsent(id, a), matches.recordContinuationConsent(id, b)]);
    expect(results.sort()).toEqual(['confirmed', 'pending']);
    expect(await matches.recordContinuationConsent(id, a)).toBe('invalid_state');
    const row = (await pool.query(`SELECT status, continuation_initiator_id FROM match_init WHERE id=$1`, [id])).rows[0];
    expect(row.status).toBe('confirmed');
    expect((await pool.query('SELECT user_id, used_count FROM continuation_usage')).rows).toEqual([
      { user_id: row.continuation_initiator_id, used_count: 1 },
    ]);
    expect((await pool.query('SELECT count(*)::integer AS count FROM match_state WHERE match_id=$1 AND continued', [id])).rows[0].count).toBe(2);
  });

  it('does not overspend the last Free slot across distinct concurrently confirmed matches', async () => {
    const [a, b, c] = await Promise.all([fixture.account(), fixture.account(), fixture.account()]);
    const first = await fixture.match(a, b), second = await fixture.match(a, c);
    await pool.query(`INSERT INTO continuation_usage(user_id, week_start, used_count)
      VALUES ($1, date_trunc('week', clock_timestamp() AT TIME ZONE 'UTC')::date, 2)`, [a]);
    await Promise.all([matches.recordContinuationConsent(first, a), matches.recordContinuationConsent(second, a)]);
    const result = await Promise.all([matches.recordContinuationConsent(first, b), matches.recordContinuationConsent(second, c)]);
    expect(result.sort()).toEqual(['confirmed', 'quota_reached']);
    expect((await pool.query('SELECT used_count FROM continuation_usage WHERE user_id=$1', [a])).rows[0].used_count).toBe(3);
    const waiting = (await pool.query("SELECT id FROM match_init WHERE status='awaiting_continuation'")).rows[0].id;
    expect((await pool.query('SELECT count(*)::integer AS count FROM match_state WHERE match_id=$1 AND continued', [waiting])).rows[0].count).toBe(1);
  });

  it('expires a closed continuation window without charging quota or recording consent', async () => {
    const a = await fixture.account(), b = await fixture.account(), id = await fixture.match(a, b);
    await pool.query("UPDATE match_init SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
    expect(await matches.recordContinuationConsent(id, a)).toBe('expired');
    expect((await pool.query('SELECT * FROM continuation_usage')).rowCount).toBe(0);
    expect((await pool.query('SELECT continued FROM match_state WHERE match_id=$1', [id])).rows.every(row => !row.continued)).toBe(true);
  });

  it('does not grant an initial continuation when the configured Free quota is zero', async () => {
    const a = await fixture.account(), b = await fixture.account(), id = await fixture.match(a, b);
    await pool.query("UPDATE subscription_plan SET weekly_continuation_limit=0 WHERE code='free'");
    try {
      expect(await matches.recordContinuationConsent(id, a)).toBe('pending');
      expect(await matches.recordContinuationConsent(id, b)).toBe('quota_reached');
      expect((await pool.query('SELECT 1 FROM continuation_usage')).rowCount).toBe(0);
      expect((await pool.query('SELECT status FROM match_init WHERE id=$1', [id])).rows[0].status).toBe('awaiting_continuation');
    } finally { await pool.query("UPDATE subscription_plan SET weekly_continuation_limit=3 WHERE code='free'"); }
  });

  it.each(['continuation', 'message'] as const)('checks the expiration after waiting for the match lock: %s', async command => {
    const a = await fixture.account(), b = await fixture.account(), id = await fixture.match(a, b);
    const blocker = await pool.connect();
    let outcome: Promise<unknown> | undefined;
    try {
      // Set the deadline before the competing statement starts, on a separate
      // transaction. The blocker itself must not modify the row after that read.
      await pool.query("UPDATE match_init SET expires_at=clock_timestamp()+interval '3 seconds' WHERE id=$1", [id]);
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM match_init WHERE id=$1 FOR UPDATE', [id]);
      const operation = command === 'continuation' ? matches.recordContinuationConsent(id, a)
        : new MatchMessageRepository(database).createMessage(randomUUID(), id, a, 'temporary', randomUUID());
      outcome = operation.then(value => value, error => error);
      await eventually(async () => (await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE application_name=$1 AND wait_event_type='Lock'`, [fixture.schema])).rowCount! > 0);
      expect((await pool.query('SELECT expires_at > clock_timestamp() AS open FROM match_init WHERE id=$1', [id])).rows[0].open).toBe(true);
      await eventually(async () => (await pool.query('SELECT expires_at < clock_timestamp() AS expired FROM match_init WHERE id=$1', [id])).rows[0].expired);
    } finally { await blocker.query('COMMIT'); blocker.release(); await outcome; }
    expect(await outcome).toEqual(command === 'continuation' ? 'expired' : { ok: false, reason: 'expired' });
    expect((await pool.query('SELECT 1 FROM chat_message')).rowCount).toBe(0);
  });

  it.each([true, false])('retains a re-registration restriction only for an erased banned account: %s', async banned => {
    const id = await fixture.account(), phoneHash = `r03-${id}`;
    await pool.query('UPDATE user_account SET is_banned=$2 WHERE user_id=$1', [id, banned]);
    await pool.query('SELECT fct_anonymize_user($1)', [id]);
    expect(await auth.findAccountByPhoneHash(phoneHash)).toBeUndefined();
    const tombstone = (await pool.query('SELECT reason, expires_at > now() AS active FROM account_tombstone WHERE phone_number_hash=$1', [phoneHash])).rows[0];
    if (banned) {
      expect(tombstone).toEqual({ reason: 'banned_account', active: true });
      await expect(auth.createAccount({ userId: randomUUID(), phoneHash, encryptedPhone: Buffer.alloc(0) })).rejects.toBeInstanceOf(AccountTombstoneError);
    } else {
      expect(tombstone).toBeUndefined();
      await expect(auth.createAccount({ userId: randomUUID(), phoneHash, encryptedPhone: Buffer.alloc(0) })).resolves.toMatchObject({ is_banned: false });
    }
  });

  it('allows registration after a tombstone expires even before its maintenance purge', async () => {
    const hash = `r03-${randomUUID()}`;
    await pool.query("INSERT INTO account_tombstone(phone_number_hash,reason,expires_at) VALUES ($1,'banned_account',now()-interval '1 second')", [hash]);
    await expect(auth.createAccount({ userId: randomUUID(), phoneHash: hash, encryptedPhone: Buffer.alloc(0) })).resolves.toMatchObject({ role: 'user' });
  });

  it.each(['sensitive_data_consent', 'location_consent'] as const)('withdraws %s atomically and removes the profile from discovery', async type => {
    const viewer = await fixture.account(), target = await fixture.account();
    await ready(viewer); await ready(target);
    expect((await discovery.candidateBatch(viewer, 'v1', 'v1', 10)).map(row => row.user_id)).toContain(target);
    await users.recordConsents(target, [{ consent_type: type, granted: false, document_version: 'v1' }], '', '');
    if (type === 'sensitive_data_consent') {
      expect((await users.findProfile(target))?.sex).toBeNull();
      expect(await users.findPreferences(target)).toBeUndefined();
    } else expect((await pool.query('SELECT 1 FROM user_presence WHERE user_id=$1', [target])).rowCount).toBe(0);
    expect(await discovery.isDiscoveryReady(target, 'v1', 'v1')).toBe(false);
    expect(await discovery.candidateBatch(viewer, 'v1', 'v1', 10)).toEqual([]);
    const match = await fixture.match(viewer, target);
    const rows = await matches.listDetailedForUser(viewer, 10, 0);
    expect(rows[0].id).toBe(match);
    if (type === 'sensitive_data_consent') expect(rows[0].other_sex).toBeNull();
  });

  it.each(['profile', 'preferences', 'presence'] as const)('does not restore %s after a withdrawal between validation and persistence', async kind => {
    const id = await fixture.account(); await ready(id);
    const read = deferred(), resume = deferred();
    const original = users.activeLegalChoices.bind(users);
    jest.spyOn(users, 'activeLegalChoices').mockImplementationOnce(async (...args) => {
      const result = await original(...args); read.resolve(); await resume.promise; return result;
    });
    const work = kind === 'profile' ? service.updateProfile(id, { firstname: 'After', birthdate: '1990-01-01', sex: 'male', bio: null })
      : kind === 'preferences' ? service.updatePreferences(id, { min_age: 18, max_age: 99, max_distance_km: 20, looking_for: 'both' })
        : service.updatePresence(id, { latitude: 48, longitude: 2 });
    const settled = work.then(() => ({ code: 'unexpected_success' }), error => error as { code: string });
    try {
      await read.promise;
      await users.recordConsents(id, [{ consent_type: kind === 'presence' ? 'location_consent' : 'sensitive_data_consent', granted: false, document_version: 'v1' }], '', '');
    } finally { resume.resolve(); }
    expect(await settled).toMatchObject({ code: 'required_consent_missing' });
    if (kind === 'profile') expect((await users.findProfile(id))?.sex).toBeNull();
    else expect((await pool.query(`SELECT 1 FROM ${kind === 'presence' ? 'user_presence' : 'user_preferences'} WHERE user_id=$1`, [id])).rowCount).toBe(0);
  });

  it('paginates tied and microsecond match activity across both participant branches', async () => {
    const viewer = await fixture.account('80000000-0000-4000-8000-000000000000');
    const peers = ['10000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000002'];
    for (const peer of peers) {
      await fixture.account(peer); const id = await fixture.match(viewer, peer);
      await pool.query("UPDATE match_init SET created_at='2026-01-01T00:00:00.000001Z',last_message_at=NULL WHERE id=$1", [id]);
    }
    const firstId = (await pool.query('SELECT id FROM match_init ORDER BY id LIMIT 1')).rows[0].id;
    await pool.query("UPDATE match_init SET last_message_at='2026-01-01T00:00:00.000002Z' WHERE id=$1", [firstId]);
    const all = await matches.listDetailedForUser(viewer, 100, 0);
    const collected: string[] = []; let cursor: KeysetCursor | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await matches.listDetailedForUser(viewer, 1, 0, cursor);
      if (!page.length) break;
      collected.push(page[0].id); cursor = { at: page[0].cursor_at, id: page[0].id };
    }
    expect(collected).toEqual(all.map(row => row.id));
    expect(new Set(collected).size).toBe(4);
    expect(all[0].cursor_at).toBe('2026-01-01T00:00:00.000002Z');
    expect((await matches.listForUser(viewer, 2, 2)).map(row => row.id)).toEqual(collected.slice(2));
  });

  it.each(['profile', 'preferences', 'presence'] as const)('serializes a withdrawal behind an already executing %s mutation', async kind => {
    const id = await fixture.account(); await ready(id);
    const written = deferred(), commit = deferred();
    const transaction = database.transaction.bind(database);
    jest.spyOn(database, 'transaction').mockImplementationOnce(work => transaction(async client => {
      const result = await work(client); written.resolve(); await commit.promise; return result;
    }));
    const write = kind === 'profile' ? service.updateProfile(id, { firstname: 'Before', birthdate: '1990-01-01', sex: 'male', bio: null })
      : kind === 'preferences' ? service.updatePreferences(id, { min_age: 18, max_age: 99, max_distance_km: 20, looking_for: 'both' })
        : service.updatePresence(id, { latitude: 48, longitude: 2 });
    const settledWrite = write.then(() => undefined, error => error);
    let withdrawal: Promise<boolean> | undefined;
    try {
      await written.promise;
      withdrawal = users.recordConsents(id, [{ consent_type: kind === 'presence' ? 'location_consent' : 'sensitive_data_consent', granted: false, document_version: 'v1' }], '', '');
      await eventually(async () => (await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE application_name=$1 AND wait_event_type='Lock'`, [fixture.schema])).rowCount! > 0);
    } finally { commit.resolve(); await settledWrite; await withdrawal; }
    expect(await settledWrite).toBeUndefined();
    if (kind === 'profile') expect((await users.findProfile(id))?.sex).toBeNull();
    else expect((await pool.query(`SELECT 1 FROM ${kind === 'presence' ? 'user_presence' : 'user_preferences'} WHERE user_id=$1`, [id])).rowCount).toBe(0);
  });

  it.each(['banned', 'erased'] as const)('refuses new matches and discovery for an account that is %s', async restriction => {
    const a = await fixture.account(), b = await fixture.account(); await ready(a); await ready(b);
    await pool.query(restriction === 'banned' ? 'UPDATE user_account SET is_banned=true WHERE user_id=$1'
      : 'UPDATE user_account SET deleted_at=now() WHERE user_id=$1', [b]);
    expect(await discovery.candidateBatch(a, 'v1', 'v1', 10)).toEqual([]);
    const [first, second] = [a, b].sort();
    await expect(matches.create({ id: randomUUID(), user1_id: first, user2_id: second, status: 'active',
      expires_at: new Date(Date.now() + 60_000), purge_after: null, continuation_initiator_id: null,
      created_at: new Date(), last_message_at: null })).rejects.toMatchObject({ reason: 'not_found' });
    expect((await pool.query('SELECT 1 FROM match_init')).rowCount).toBe(0);
  });

  it('paginates reports without duplicates after a newer insert and preserves the status filter', async () => {
    const reporter = await fixture.account(), target = await fixture.account();
    const reports = new ReportsRepository(database);
    for (let i = 0; i < 5; i++) await pool.query(`INSERT INTO user_report(id,reporter_id,reported_id,reason,status,created_at)
      VALUES ($1,$2,$3,'spam',$4,'2026-01-01T00:00:00.000001Z')`, [randomUUID(), await fixture.account(), target, i === 4 ? 'reviewed' : 'pending']);
    const expected = await reports.list('pending', 100, 0), first = await reports.list('pending', 2, 0);
    await pool.query("INSERT INTO user_report(reporter_id,reported_id,reason) VALUES ($1,$2,'spam')", [reporter, target]);
    const last = first.at(-1)!;
    const second = await reports.list('pending', 2, 0, { at: last.cursor_at, id: last.id });
    expect([...first, ...second].map(row => row.id)).toEqual(expected.map(row => row.id));
    const end = second.at(-1)!;
    expect(await reports.list('pending', 2, 0, { at: end.cursor_at, id: end.id })).toEqual([]);
  });

  it('runs match maintenance under a single leader and cascades expired messages and state', async () => {
    const a = await fixture.account(), b = await fixture.account(), c = await fixture.account();
    const expiring = await fixture.match(a, b), purging = await fixture.match(a, c, 'active');
    await pool.query("INSERT INTO chat_message(match_id,sender_id,content) VALUES ($1,$2,'temporary')", [purging, a]);
    await pool.query("UPDATE match_init SET expires_at=now()-interval '1 second' WHERE id=$1", [expiring]);
    await pool.query("UPDATE match_init SET status='ended',purge_after=now()-interval '1 second' WHERE id=$1", [purging]);
    const maintenance = new MatchMaintenanceRepository(database);
    const leader = await pool.connect();
    try {
      await leader.query('BEGIN'); await leader.query('SELECT pg_advisory_xact_lock(37142581)');
      expect(await maintenance.runMaintenanceAsLeader(new Date())).toBeUndefined();
      await leader.query('COMMIT');
    } finally { await leader.query('ROLLBACK'); leader.release(); }
    const runs = await Promise.all([maintenance.runMaintenanceAsLeader(new Date()), maintenance.runMaintenanceAsLeader(new Date())]);
    expect(runs.reduce((n, result) => n + (result?.purged ?? 0), 0)).toBe(1);
    expect(runs.reduce((n, result) => n + (result?.expired ?? 0), 0)).toBe(1);
    expect((await pool.query('SELECT 1 FROM chat_message WHERE match_id=$1', [purging])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM match_state WHERE match_id=$1', [purging])).rowCount).toBe(0);
  });

  it('purges expired privacy data in bounded batches while preserving live rows', async () => {
    const a = await fixture.account(), b = await fixture.account();
    await ready(a); await ready(b);
    const now = new Date();
    await pool.query("UPDATE user_presence SET updated_at=$1::timestamptz-interval '25 hours' WHERE user_id=$2", [now, a]);
    for (let i = 0; i < 3; i++) await pool.query(`INSERT INTO otp_verification(phone_number_hash,otp_hash,expires_at)
      VALUES ($1,'temporary',$2::timestamptz-interval '1 second')`, [`r03-${i}`, now]);
    await pool.query(`INSERT INTO account_tombstone(phone_number_hash,reason,expires_at)
      VALUES ('r03-expired','banned_account',$1::timestamptz),('r03-live','banned_account',$1::timestamptz+interval '1 day')`, [now]);
    await pool.query(`INSERT INTO data_subject_request(user_id,type,status,completed_at)
      VALUES ($1,'access','completed',$3::timestamptz-interval '6 years'),($2,'access','in_progress',NULL)`, [a, b, now]);
    await pool.query(`INSERT INTO user_report(reporter_id,reported_id,reason,status,resolved_at)
      VALUES ($1,$2,'spam','reviewed',$3::timestamptz-interval '4 years'),($1,$2,'spam','pending',NULL)`, [a, b, now]);
    const first = await privacy.runMaintenanceAsLeader(now, 1);
    expect(first).toMatchObject({ expired_otps: 1, expired_presences: 1, expired_account_tombstones: 1, expired_data_subject_requests: 1, expired_reports: 1 });
    await Promise.all([privacy.runMaintenanceAsLeader(now, 1), privacy.runMaintenanceAsLeader(now, 1)]);
    await privacy.runMaintenanceAsLeader(now, 1);
    expect((await pool.query('SELECT 1 FROM otp_verification')).rowCount).toBe(0);
    expect((await pool.query('SELECT user_id FROM user_presence')).rows).toEqual([{ user_id: b }]);
    expect((await pool.query('SELECT phone_number_hash FROM account_tombstone')).rows).toEqual([{ phone_number_hash: 'r03-live' }]);
    expect((await pool.query('SELECT status FROM data_subject_request')).rows).toEqual([{ status: 'in_progress' }]);
    expect((await pool.query('SELECT status FROM user_report')).rows).toEqual([{ status: 'pending' }]);
  });

  it('purges expired admin sessions, audits, consents and notifications while keeping active counterparts', async () => {
    const owner = await fixture.account(), credential = randomUUID();
    await pool.query(`INSERT INTO admin_webauthn_credential(id,user_id,credential_id,public_key,device_type,backed_up,name)
      VALUES ($1,$2,$3,$4,'singleDevice',false,'Fixture')`, [credential, owner, randomUUID(), Buffer.from([1])]);
    for (const expired of [true, false]) {
      const created = expired ? '2020-01-01T00:00:00Z' : '2026-01-01T00:00:00Z';
      const expires = expired ? '2020-01-02T00:00:00Z' : '2090-01-01T00:00:00Z';
      await pool.query(`INSERT INTO admin_webauthn_bootstrap(id,user_id,secret_hash,created_at,expires_at,consumed_at)
        VALUES ($1,$2,$3,$4,$5,$6)`, [randomUUID(), owner, Buffer.alloc(32), created, expires, expired ? created : null]);
      await pool.query(`INSERT INTO admin_webauthn_challenge(purpose,challenge_hash,created_at,expires_at)
        VALUES ('authentication',$1,$2,$3)`, [Buffer.alloc(32), created, expires]);
      await pool.query(`INSERT INTO admin_session(user_id,credential_id,token_hash,created_at,idle_expires_at,absolute_expires_at)
        VALUES ($1,$2,$3,$4,$5,$5)`, [owner, credential, Buffer.alloc(32, expired ? 1 : 2), created, expires]);
      await pool.query("INSERT INTO admin_auth_event(user_id,event_type,created_at) VALUES ($1,'login_succeeded',$2)", [owner, created]);
      await pool.query(`INSERT INTO outbox_operator_action(administrator_id,administrator_role,event_type,action,reason,created_at)
        VALUES ($1,'admin','photo.delete','retry','Fixture retry',$2)`, [owner, created]);
      await pool.query(`INSERT INTO data_access_log(accessed_user_id,accessor_role,action,reason,accessed_at)
        VALUES ($1,'system','system_anonymize','Fixture',$2)`, [owner, created]);
      await pool.query('INSERT INTO account_deletion_token(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)',
        [randomUUID(), expired ? owner : await fixture.account(), randomUUID(), expires]);
      await pool.query("INSERT INTO notification(user_id,type,expires_at) VALUES ($1,'profile_liked',$2)", [owner, expires]);
      await pool.query(`INSERT INTO user_consent(user_id,consent_type,granted,document_version,granted_at,withdrawn_at)
        VALUES ($1,'location_consent',$2,'fixture',$3,$4)`, [owner, !expired, created, expired ? created : null]);
    }
    // Fixed reference date makes all retention boundaries deterministic.
    const result = await privacy.runMaintenanceAsLeader(new Date('2026-09-04T00:00:00Z'), 10);
    expect(result).toMatchObject({ expired_admin_webauthn_challenges: 1, expired_admin_webauthn_bootstraps: 1,
      expired_admin_sessions: 1, expired_admin_auth_events: 1, expired_outbox_operator_actions: 1,
      expired_data_access_logs: 1, expired_account_deletion_tokens: 1, expired_notifications: 1, expired_consents: 1 });
    for (const table of ['admin_webauthn_challenge', 'admin_webauthn_bootstrap', 'admin_session', 'admin_auth_event',
      'outbox_operator_action', 'data_access_log', 'account_deletion_token', 'notification', 'user_consent']) {
      expect((await pool.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count).toBe(1);
    }
    expect((await pool.query('SELECT 1 FROM admin_webauthn_credential')).rowCount).toBe(1);
  });
});
