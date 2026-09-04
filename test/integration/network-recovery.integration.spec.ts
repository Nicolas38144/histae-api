import { randomUUID } from 'node:crypto';
import * as scyllaClients from '../../src/scylla/scylla.client';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import { ConfigService } from '../../src/config/config.service';
import { RedisService } from '../../src/redis/redis.service';
import { RateLimitService } from '../../src/ratelimit/rate-limit.service';
import { ScyllaService } from '../../src/scylla/scylla.service';
import { DiscoveryStore } from '../../src/discovery/discovery.store';
import { ObjectStorageService } from '../../src/storage/object-storage.service';
import { PhotosRepository } from '../../src/photos/photos.repository';
import { OutboxRepository } from '../../src/outbox/outbox.repository';
import { OutboxWorkerService } from '../../src/outbox/outbox-worker.service';
import { accountActivityStub } from '../account-activity.stub';
import { IsolatedPostgres, eventually } from '../helpers/isolated-postgres';
import { TcpFaultProxy } from '../helpers/tcp-fault-proxy';

jest.setTimeout(60_000);

describe('Real local dependency recovery through disposable TCP relays', () => {
  const fixture = new IsolatedPostgres();
  let config: ConfigService;
  beforeAll(async () => { config = new ConfigService(); await fixture.start(); });
  afterEach(async () => { jest.restoreAllMocks(); await fixture.reset(); });
  afterAll(() => fixture.stop());

  it('fails Redis rate limiting closed during disconnection and reuses the same counter after recovery', async () => {
    const address = new URL(`redis://${config.redis.address}`);
    const proxy = await new TcpFaultProxy(address.hostname, Number(address.port || 6379)).start();
    const testConfig = { redis: { ...config.redis, address: `127.0.0.1:${proxy.port}`, db: 15,
      tls: false, connectTimeoutMillis: 500, commandTimeoutMillis: 250 },
      rateLimit: { store: 'redis' }, phone: { hashKey: 'r03-temporary-key-material-32-bytes' } } as ConfigService;
    const redis = new RedisService(testConfig), limits = new RateLimitService(testConfig, redis);
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const id = randomUUID(), policy = { max: 1, windowMs: 30_000 };
    try {
      await redis.onModuleInit();
      await limits.enforce('r03-network', id, policy, 'r03_limit');
      proxy.cut();
      await eventually(async () => log.mock.calls.length > 0);
      await expect(limits.enforce('r03-network', id, policy, 'r03_limit')).rejects.toMatchObject({ status: 503, code: 'rate_limit_unavailable' });
      proxy.resume();
      await eventually(async () => { try { await redis.check(); return true; } catch { return false; } });
      await expect(limits.enforce('r03-network', id, policy, 'r03_limit')).rejects.toMatchObject({ status: 429, code: 'r03_limit' });
      expect(proxy.connections).toBeGreaterThan(1);
    } finally { proxy.resume(); await redis.onModuleDestroy(); await proxy.stop(); }
  });

  it('keeps Scylla decisions immutable through a real socket cut and resumes cross-view erasure', async () => {
    if (config.scylla.keyspace !== 'histae_discovery' || config.scylla.contactPoints.length !== 1 || config.scylla.tls) {
      throw new Error('Fault test requires a single local development Scylla node without TLS.');
    }
    const proxy = await new TcpFaultProxy(config.scylla.contactPoints[0], config.scylla.port).start();
    // Observe the real production driver's host replacement after the cut.
    // Queries and connection policies are not mocked. The pinned driver patch
    // must close the retired pool so this suite can exit without forceExit.
    let retiredHosts = 0;
    const createClient = scyllaClients.createScyllaClient;
    jest.spyOn(scyllaClients, 'createScyllaClient').mockImplementationOnce(settings => {
      const client = createClient(settings);
      client.on('hostRemove', () => { retiredHosts++; });
      return client;
    });
    const scylla = new ScyllaService({ scylla: { ...config.scylla, enabled: true,
      contactPoints: ['127.0.0.1'], port: proxy.port, connectTimeoutMillis: 500, requestTimeoutMillis: 500 } } as ConfigService);
    const direct = new ScyllaService(config);
    const store = new DiscoveryStore(scylla, accountActivityStub), cleanup = new DiscoveryStore(direct, accountActivityStub);
    const a = randomUUID(), b = randomUUID();
    try {
      await direct.onModuleInit(); await scylla.onModuleInit();
      expect(await store.recordSwipe(a, b, 'like')).toMatchObject({ created: true, decision: 'like' });
      proxy.cut();
      await expect(store.deleteUserDataBatch(a, 0)).rejects.toThrow('ScyllaDB query failed');
      proxy.resume();
      await eventually(async () => { try { await scylla.check(); return true; } catch { return false; } }, 15_000);
      expect(await store.recordSwipe(a, b, 'pass')).toMatchObject({ created: false, decision: 'like' });
      await store.deleteUserData(a);
      expect(await cleanup.exportOwnActions(a)).toEqual([]);
      expect(await cleanup.findSwipe(a, b)).toBeUndefined();
      expect(proxy.connections).toBeGreaterThan(1);
      expect(retiredHosts).toBeGreaterThan(0);
    } finally {
      proxy.resume();
      try { await cleanup.deleteUserData(a); await cleanup.deleteUserData(b); }
      finally { await scylla.onModuleDestroy(); await direct.onModuleDestroy(); await proxy.stop(); }
    }
  });

  it('retains the photo trace after an S3 DELETE response is lost and completes the outbox retry', async () => {
    const endpoint = new URL(config.objectStorage.endpoint);
    if (endpoint.protocol !== 'http:' || endpoint.username || endpoint.password) throw new Error('Fault test requires local plain HTTP S3.');
    const proxy = await new TcpFaultProxy(endpoint.hostname, Number(endpoint.port || 80)).start();
    const direct = new ObjectStorageService(config);
    const storage = new ObjectStorageService({ objectStorage: { ...config.objectStorage, endpoint: `http://127.0.0.1:${proxy.port}` } } as ConfigService);
    const inspector = new S3Client({ endpoint: config.objectStorage.endpoint, region: config.objectStorage.region,
      forcePathStyle: config.objectStorage.forcePathStyle, maxAttempts: 1,
      credentials: { accessKeyId: config.objectStorage.accessKey, secretAccessKey: config.objectStorage.secretKey } });
    const owner = await fixture.account(), id = randomUUID(), key = `profile-photos/${owner}/${id}.webp`;
    const outbox = new OutboxRepository(fixture.database), photos = new PhotosRepository(fixture.database, outbox);
    const worker = new OutboxWorkerService(outbox, photos, storage, { maintenanceMode: 'disabled' } as never,
      {} as never, {} as never, {} as never);
    try {
      await direct.put({ key, body: Buffer.from('r03-temporary-object'), contentType: 'image/webp' });
      await fixture.pool.query(`INSERT INTO user_photo(id,user_id,object_key,status) VALUES ($1,$2,$3,'deleting')`, [id, owner, key]);
      await outbox.enqueue(fixture.database, { eventType: 'photo.delete', aggregateId: id });
      proxy.dropNextReply();
      expect(await worker.runOnce()).toMatchObject({ retried: 1, completed: 0 });
      expect((await fixture.pool.query('SELECT status FROM user_photo WHERE id=$1', [id])).rows).toEqual([{ status: 'deleting' }]);
      await expect(inspector.send(new HeadObjectCommand({ Bucket: config.objectStorage.bucket, Key: key })))
        .rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
      proxy.resume();
      await fixture.pool.query("UPDATE outbox_event SET available_at=now()-interval '1 second'");
      expect(await worker.runOnce()).toMatchObject({ completed: 1, retried: 0 });
      expect((await fixture.pool.query('SELECT 1 FROM user_photo WHERE id=$1', [id])).rowCount).toBe(0);
      expect((await fixture.pool.query('SELECT status FROM outbox_event')).rows).toEqual([{ status: 'completed' }]);
    } finally {
      proxy.resume();
      try { await direct.delete(key); }
      finally { storage.onModuleDestroy(); direct.onModuleDestroy(); inspector.destroy(); await proxy.stop(); }
    }
  });
});
