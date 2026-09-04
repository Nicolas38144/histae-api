import { DatabaseService } from '../../src/database/database.service';
import { AccountActivityService } from '../../src/database/account-activity.service';
import { ErasureRepository } from '../../src/privacy/erasure.repository';
import { ErasureService } from '../../src/privacy/erasure.service';
import { OutboxRepository } from '../../src/outbox/outbox.repository';
import { OutboxWorkerService } from '../../src/outbox/outbox-worker.service';
import type { PoolConfig } from 'pg';

// Launched only by the crash integration suite. Configuration travels through
// private IPC, never argv, logs or a generated file containing credentials.
process.once('message', async (input: { postgres: PoolConfig; afterCheckpoint: boolean }) => {
  try {
    if (input.postgres.database !== 'histae-dev'
      || !['localhost', '127.0.0.1', '::1'].includes(input.postgres.host ?? '')
      || !/^-c search_path=r03_test_[a-f0-9]{32},public$/.test(input.postgres.options ?? '')) {
      throw new Error('Unsafe crash fixture target.');
    }
    const config = { postgres: input.postgres } as never;
    const database = new DatabaseService(config), activity = new AccountActivityService(config);
    const repository = new ErasureRepository(database), outbox = new OutboxRepository(database);
    const advance = repository.advance.bind(repository);
    const pause = async () => {
      process.send?.({ type: 'paused' });
      await new Promise<void>(() => { /* Parent terminates this owned process. */ });
    };
    repository.advance = async (...args) => {
      if (!input.afterCheckpoint) await pause();
      const result = await advance(...args);
      if (input.afterCheckpoint) await pause();
      return result;
    };
    const erasure = new ErasureService(repository, activity,
      { deleteCustomerForAccount: async () => true } as never,
      { deleteForAccount: async () => true } as never,
      { deleteUserDataBatch: async () => true } as never);
    const worker = new OutboxWorkerService(outbox, {} as never, {} as never,
      { maintenanceMode: 'disabled' } as never, {} as never, {} as never, erasure);
    await worker.runOnce();
    process.send?.({ type: 'unexpected_completion' });
  } catch { process.send?.({ type: 'failed' }); }
});
