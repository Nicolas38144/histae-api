import type { Readable } from 'node:stream';

import { DataExportService } from '../../../src/privacy/data-export.service';
import type { JsonExportWriter } from '../../../src/privacy/json-export.writer';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';

describe('DataExportService', () => {
  it('builds a bounded private JSON download and includes only visited outgoing actions', async () => {
    const exports = {
      writeSnapshot: jest.fn(async (_userId: string, writer: JsonExportWriter) => {
        await writer.startArray('traits');
        await writer.item({ id: TARGET_ID, name: 'Hiking' });
        await writer.endArray();
        await writer.startObject('discovery_actions');
        await writer.startArray('outgoing');
        await writer.item({ actor_id: USER_ID, target_id: TARGET_ID, decision: 'like', swiped_at: new Date('2030-01-02') });
        await writer.endArray();
        await writer.endObject();
        return {
          snapshotAt: new Date('2030-01-01T00:00:00.000Z'),
          account: { user_id: USER_ID },
          profile: { firstname: 'Ada' },
          photoKey: null,
          preferences: null,
          subscription: null,
          discoveryRows: 1,
        };
      }),
    };
    const privacy = { recordSelfExport: jest.fn().mockResolvedValue(undefined) };
    const photos = { urlForKey: jest.fn().mockResolvedValue(null) };
    const config = {
      workloads: { dataExportPageSize: 25, dataExportMaxBytes: 1_048_576, dataExportMaxConcurrency: 2 },
    };
    const service = new DataExportService(
      exports as never,
      privacy as never,
      photos as never,
      config as never,
    );

    const prepared = await service.prepare(USER_ID);
    const body = await readStream(prepared.getStream());
    const parsed = JSON.parse(body) as {
      account: unknown;
      profile: unknown;
      discovery_actions: { outgoing: unknown[] };
      consistency: unknown;
    };

    expect(parsed.account).toEqual({ user_id: USER_ID });
    expect(parsed.profile).toEqual({ firstname: 'Ada', photo: null });
    expect(parsed.discovery_actions.outgoing).toEqual([
      expect.objectContaining({ actor_id: USER_ID, target_id: TARGET_ID, decision: 'like' }),
    ]);
    expect(parsed.consistency).toEqual(expect.objectContaining({
      postgres: { level: 'repeatable_read', snapshot_at: '2030-01-01T00:00:00.000Z' },
      discovery: expect.objectContaining({
        level: 'repeatable_read', snapshot_at: '2030-01-01T00:00:00.000Z', rows: 1,
      }),
    }));
    expect(prepared.getHeaders()).toEqual(expect.objectContaining({
      type: 'application/json; charset=utf-8',
      disposition: 'attachment; filename="histae-data-export.json"',
    }));
    expect(exports.writeSnapshot).toHaveBeenCalledWith(USER_ID, expect.any(Object), 25);
    expect(privacy.recordSelfExport).toHaveBeenCalledWith(USER_ID);
  });

  it('fails before exposing a partial response when the configured export limit is exceeded', async () => {
    const exports = {
      writeSnapshot: jest.fn(async (_userId: string, writer: JsonExportWriter) => {
        await writer.property('oversized', 'x'.repeat(2_000));
        throw new Error('unreachable');
      }),
    };
    const service = new DataExportService(
      exports as never,
      { recordSelfExport: jest.fn() } as never,
      {} as never,
      { workloads: { dataExportPageSize: 25, dataExportMaxBytes: 100, dataExportMaxConcurrency: 2 } } as never,
    );

    await expect(service.prepare(USER_ID)).rejects.toMatchObject({ status: 413, code: 'data_export_too_large' });
  });

  it('bounds concurrent temporary exports until their response stream closes', async () => {
    const exports = {
      writeSnapshot: jest.fn(async (_userId: string, _writer: JsonExportWriter) => ({
        snapshotAt: new Date('2030-01-01T00:00:00.000Z'),
        account: null,
        profile: null,
        photoKey: null,
        preferences: null,
        subscription: null,
        discoveryRows: 0,
      })),
    };
    const service = new DataExportService(
      exports as never,
      { recordSelfExport: jest.fn().mockResolvedValue(undefined) } as never,
      { urlForKey: jest.fn().mockResolvedValue(null) } as never,
      { workloads: {
        dataExportPageSize: 25,
        dataExportMaxBytes: 1_048_576,
        dataExportMaxConcurrency: 1,
      } } as never,
    );

    const first = await service.prepare(USER_ID);
    await expect(service.prepare(TARGET_ID)).rejects.toMatchObject({
      status: 503,
      code: 'data_export_busy',
      retryAfterSeconds: 30,
    });
    const firstStream = first.getStream();
    const closed = new Promise((resolve) => firstStream.once('close', resolve));
    firstStream.destroy();
    await closed;
    const next = await prepareAfterCleanup(service, TARGET_ID);
    await readStream(next.getStream());
  });
});

async function prepareAfterCleanup(service: DataExportService, userId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await service.prepare(userId);
    } catch (error: unknown) {
      if (!(typeof error === 'object' && error !== null && 'code' in error
        && error.code === 'data_export_busy')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error('temporary export cleanup did not release its concurrency slot');
}

async function readStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}
