import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { IsolatedPostgres, eventually } from '../helpers/isolated-postgres';
import { TcpFaultProxy } from '../helpers/tcp-fault-proxy';
import { AccountActivityService } from '../../src/database/account-activity.service';
import { UsersRepository } from '../../src/users/users.repository';
import { ErasureRepository } from '../../src/privacy/erasure.repository';
import { ErasureService } from '../../src/privacy/erasure.service';
import { OutboxRepository } from '../../src/outbox/outbox.repository';

jest.setTimeout(60_000);

describe('Real worker termination and activity connection loss', () => {
  const fixture = new IsolatedPostgres();
  const activity = new AccountActivityService({ postgres: fixture.config } as never);
  const users = new UsersRepository(fixture.database), outbox = new OutboxRepository(fixture.database);
  const erasures = new ErasureRepository(fixture.database);
  const service = new ErasureService(erasures, activity,
    { deleteCustomerForAccount: async () => true } as never,
    { deleteForAccount: async () => true } as never,
    { deleteUserDataBatch: async () => true } as never);

  beforeAll(() => fixture.start());
  afterEach(() => fixture.reset());
  afterAll(async () => { await activity.onModuleDestroy(); await fixture.stop(); });

  it.each(['stripe', 'photos', 'scylla', 'postgres', 'completed'])('resumes after killing a real process at %s', async step => {
    const owner = await fixture.account(), token = randomUUID();
    await users.replaceDeletionToken(owner, token, 'fixture-token', new Date(Date.now() + 60_000));
    const accepted = await users.acceptErasure(owner, token, 'fixture-token', new Date());
    await fixture.pool.query(`UPDATE account_erasure SET step=$2, scylla_partition=$3 WHERE request_id=$1`,
      [accepted!.request_id, step === 'completed' ? 'postgres' : step, ['postgres', 'completed'].includes(step) ? 64 : 0]);
    const child = spawn(process.execPath, ['-r', require.resolve('ts-node/register/transpile-only'), join(__dirname, '../helpers/erasure-crash-child.ts')], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    try {
      await waitForPause(child, () => child.send({ postgres: fixture.config, afterCheckpoint: step === 'completed' }));
      expect(await activity.tryExclusive(owner, async () => undefined)).toEqual({ acquired: false });
      await killOwnedChild(child);
      await eventually(async () => (await activity.tryExclusive(owner, async () => true)).acquired);
      const saved = (await fixture.pool.query('SELECT step FROM account_erasure WHERE request_id=$1', [accepted!.request_id])).rows[0].step;
      expect(saved).toBe(step);
      await fixture.pool.query("UPDATE outbox_event SET locked_at=now()-interval '10 minutes'");
      const workerId = randomUUID();
      for (let pass = 0; pass < 70; pass++) {
        await fixture.pool.query("UPDATE outbox_event SET available_at=now()-interval '1 second' WHERE status='pending'");
        const [event] = await outbox.claimBatch(workerId, new Date(), new Date(Date.now() - 60_000), 1);
        if (!event) break;
        if (await service.process(event.id, workerId)) await outbox.complete(event.id, workerId, new Date());
      }
      expect((await fixture.pool.query('SELECT status FROM data_subject_request WHERE id=$1', [accepted!.request_id])).rows[0].status).toBe('completed');
      expect((await fixture.pool.query('SELECT status FROM outbox_event')).rows).toEqual([{ status: 'completed' }]);
      expect((await fixture.pool.query("SELECT count(*)::integer AS count FROM data_access_log WHERE action='system_anonymize' AND accessed_user_id=$1", [owner])).rows[0].count).toBe(1);
    } finally { await killOwnedChild(child); }
  });

  it('refuses a subsequent external write after losing the PostgreSQL session that held its activity lock', async () => {
    const owner = await fixture.account();
    const proxy = await new TcpFaultProxy(fixture.config.host!, fixture.config.port).start();
    const guarded = new AccountActivityService({ postgres: { ...fixture.config, host: '127.0.0.1', port: proxy.port } } as never);
    let externalWrites = 0;
    try {
      await expect(guarded.run([owner], async assertHeld => {
        proxy.cut();
        await eventually(async () => { try { assertHeld(); return false; } catch { return true; } });
        assertHeld();
        externalWrites++;
      })).rejects.toMatchObject({ code: 'account_activity_unavailable', status: 503 });
      expect(externalWrites).toBe(0);
      expect((await activity.tryExclusive(owner, async () => true)).acquired).toBe(true);
    } finally { await guarded.onModuleDestroy(); await proxy.stop(); }
  });
});

async function waitForPause(child: ChildProcess, start: () => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Worker fixture did not reach its checkpoint.')), 45_000);
    const message = (value: { type?: string }) => finish(value.type === 'paused' ? undefined : new Error('Worker fixture failed before its checkpoint.'));
    const exited = () => finish(new Error('Worker fixture exited before its checkpoint.'));
    const finish = (error?: Error) => {
      clearTimeout(timer); child.removeListener('message', message); child.removeListener('exit', exited); child.removeListener('error', finish);
      if (error) reject(error); else resolve();
    };
    child.on('message', message); child.once('exit', exited); child.once('error', finish); start();
  });
}

async function killOwnedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned test worker did not exit.')), 5_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGKILL');
  });
}
