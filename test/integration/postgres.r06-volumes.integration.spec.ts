import { randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DataExportRepository } from '../../src/privacy/data-export.repository';
import { JsonExportWriter } from '../../src/privacy/json-export.writer';
import { MatchMaintenanceRepository } from '../../src/matches/match-maintenance.repository';
import { OutboxRepository } from '../../src/outbox/outbox.repository';
import { PrivacyRepository } from '../../src/privacy/privacy.repository';
import { PrivacyService } from '../../src/privacy/privacy.service';
import { IsolatedPostgres } from '../helpers/isolated-postgres';

jest.setTimeout(60_000);

describe('R06 bounded workloads with isolated PostgreSQL', () => {
  let fixture: IsolatedPostgres;

  beforeAll(async () => {
    fixture = new IsolatedPostgres();
    await fixture.start();
  });

  afterEach(() => fixture.reset());
  afterAll(() => fixture.stop());

  it('commits and resumes match cleanup without an unbounded child cascade', async () => {
    const owner = await fixture.account();
    for (let index = 0; index < 8; index += 1) {
      const peer = await fixture.account();
      const matchId = await fixture.match(owner, peer, 'active');
      await fixture.pool.query(`
        UPDATE match_init SET status = 'ended', purge_after = clock_timestamp() - INTERVAL '1 second'
        WHERE id = $1
      `, [matchId]);
      for (let message = 0; message < 2; message += 1) {
        await fixture.pool.query(
          'INSERT INTO chat_message(match_id, sender_id, content) VALUES ($1, $2, $3)',
          [matchId, owner, `message-${index}-${message}`],
        );
      }
      await fixture.pool.query(`
        INSERT INTO user_report(reporter_id, reported_id, match_id, reason, status, resolved_at)
        VALUES ($1, $2, $3, 'spam', 'reviewed', clock_timestamp())
      `, [owner, peer, matchId]);
    }

    const maintenance = new MatchMaintenanceRepository(fixture.database);
    let sawRemainingWork = false;
    for (let run = 0; run < 20; run += 1) {
      const result = await maintenance.runMaintenanceAsLeader(new Date(), 3, 1);
      expect(result).toBeDefined();
      expect(Math.max(
        result!.opened,
        result!.expired,
        result!.deleted_messages,
        result!.detached_reports,
        result!.purged,
      )).toBeLessThanOrEqual(3);
      sawRemainingWork ||= result!.work_remaining;
      if (!result!.work_remaining) break;
    }

    expect(sawRemainingWork).toBe(true);
    expect((await fixture.pool.query('SELECT 1 FROM match_init')).rowCount).toBe(0);
    expect((await fixture.pool.query('SELECT 1 FROM chat_message')).rowCount).toBe(0);
    expect((await fixture.pool.query('SELECT count(*)::int AS count FROM user_report WHERE match_id IS NOT NULL')).rows[0]?.count).toBe(0);
  });

  it('traverses data requests and access logs by microsecond-safe cursors', async () => {
    const userId = await fixture.account();
    const timestamp = '2030-01-01T00:00:00.000123Z';
    const requestIds = Array.from({ length: 5 }, () => randomUUID());
    const logIds = Array.from({ length: 5 }, () => randomUUID());
    for (const id of requestIds) {
      await fixture.pool.query(`
        INSERT INTO data_subject_request(id, user_id, type, status, requested_at, completed_at)
        VALUES ($1, $2, 'access', 'completed', $3, $3)
      `, [id, userId, timestamp]);
    }
    for (const id of logIds) {
      await fixture.pool.query(`
        INSERT INTO data_access_log(id, accessed_user_id, accessor_id, accessor_role, action, reason, accessed_at)
        VALUES ($1, $2, $2, 'user', 'export_data', 'Fixture export', $3)
      `, [id, userId, timestamp]);
    }

    const service = new PrivacyService(new PrivacyRepository(fixture.database));
    const requestPage1 = await service.requestsForAdmin('completed', 2, 0);
    const requestPage2 = await service.requestsForAdmin('completed', 2, 0, requestPage1.next_cursor!);
    const requestPage3 = await service.requestsForAdmin('completed', 2, 0, requestPage2.next_cursor!);
    expect([...requestPage1.items, ...requestPage2.items, ...requestPage3.items].map((row) => row.id))
      .toEqual([...requestIds].sort().reverse());
    expect(requestPage3.next_cursor).toBeNull();

    const logPage1 = await service.accessLogs(userId, 2, 0);
    const logPage2 = await service.accessLogs(userId, 2, 0, logPage1.next_cursor!);
    const logPage3 = await service.accessLogs(userId, 2, 0, logPage2.next_cursor!);
    expect([...logPage1.items, ...logPage2.items, ...logPage3.items].map((row) => row.id))
      .toEqual([...logIds].sort().reverse());
    expect(logPage3.next_cursor).toBeNull();
  });

  it('purges a backlog through repeatable bounded deletes', async () => {
    await fixture.pool.query(`
      INSERT INTO outbox_event(id, event_type, aggregate_id, status, processed_at)
      SELECT uuid_generate_v4(), 'test.cleanup', uuid_generate_v4(), 'completed',
        clock_timestamp() - INTERVAL '8 days'
      FROM generate_series(1, 1001)
    `);
    const repository = new OutboxRepository(fixture.database);
    let purged = 0;
    let batches = 0;
    while (true) {
      const count = await repository.purgeCompleted(new Date(), 128);
      expect(count).toBeLessThanOrEqual(128);
      purged += count;
      batches += 1;
      if (count < 128) break;
    }

    expect(purged).toBe(1001);
    expect(batches).toBe(8);
    expect((await fixture.pool.query('SELECT 1 FROM outbox_event')).rowCount).toBe(0);
  });

  it('writes large export collections page by page under one repeatable snapshot', async () => {
    const owner = await fixture.account();
    const peer = await fixture.account();
    const matchId = await fixture.match(owner, peer, 'confirmed');
    await fixture.pool.query(`
      INSERT INTO chat_message(match_id, sender_id, content)
      SELECT $1, $2, 'portable-message-' || value
      FROM generate_series(1, 501) AS series(value)
    `, [matchId, owner]);
    await fixture.pool.query(`
      INSERT INTO user_report(reporter_id, reported_id, match_id, reason, status, resolved_at)
      SELECT $1, $2, $3, 'spam', 'reviewed', clock_timestamp()
      FROM generate_series(1, 501)
    `, [owner, peer, matchId]);

    const directory = await mkdtemp(join(tmpdir(), 'histae-export-test-'));
    const path = join(directory, 'export.json');
    try {
      const file = await open(path, 'wx', 0o600);
      const writer = new JsonExportWriter(file, 1_048_576);
      await writer.startObject();
      const snapshot = await new DataExportRepository(fixture.database).writeSnapshot(owner, writer, 37);
      await writer.endObject();
      writer.assertComplete();
      await file.close();

      const exported = JSON.parse(await readFile(path, 'utf8')) as {
        authored_messages: Array<Record<string, unknown>>;
        submitted_reports: Array<Record<string, unknown>>;
      };
      expect(snapshot.snapshotAt).toBeInstanceOf(Date);
      expect(exported.authored_messages).toHaveLength(501);
      expect(exported.submitted_reports).toHaveLength(501);
      expect(JSON.stringify(exported)).not.toContain('cursor_at');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
