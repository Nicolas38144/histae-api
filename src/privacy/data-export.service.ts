import { Injectable, StreamableFile } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apiError } from '../common/api-error';
import { ConfigService } from '../config/config.service';
import { PhotosService } from '../photos/photos.service';
import { DataExportRepository } from './data-export.repository';
import { DataExportTooLargeError, JsonExportWriter } from './json-export.writer';
import { PrivacyRepository } from './privacy.repository';

const EXPORT_FILENAME = 'histae-data-export.json';

@Injectable()
export class DataExportService {
  private activeExports = 0;

  constructor(
    private readonly exports: DataExportRepository,
    private readonly privacy: PrivacyRepository,
    private readonly photos: PhotosService,
    private readonly config: ConfigService,
  ) {}

  async prepare(userId: string): Promise<StreamableFile> {
    const releaseSlot = this.acquireSlot();
    let directory: string | undefined;
    let file: FileHandle | undefined;

    try {
      directory = await mkdtemp(join(tmpdir(), 'histae-export-'));
      const path = join(directory, EXPORT_FILENAME);
      file = await open(path, 'wx', 0o600);
      const writer = new JsonExportWriter(file, this.config.workloads.dataExportMaxBytes);
      await writer.startObject();

      const discoveryStartedAt = new Date();
      const postgres = await this.exports.writeSnapshot(
        userId,
        writer,
        this.config.workloads.dataExportPageSize,
      );
      const discoveryCompletedAt = new Date();
      const photo = await this.photos.urlForKey(postgres.photoKey);
      await writer.property('account', postgres.account);
      await writer.property('profile', postgres.profile ? { ...postgres.profile, photo } : null);
      await writer.property('preferences', postgres.preferences);
      await writer.property('subscription', postgres.subscription);

      const completedAt = new Date();

      await writer.property('exported_at', completedAt.toISOString());
      await writer.property('consistency', {
        postgres: {
          level: 'repeatable_read',
          snapshot_at: postgres.snapshotAt.toISOString(),
        },
        discovery: {
          level: 'repeatable_read',
          snapshot_at: postgres.snapshotAt.toISOString(),
          started_at: discoveryStartedAt.toISOString(),
          completed_at: discoveryCompletedAt.toISOString(),
          rows: postgres.discoveryRows,
        },
      });
      await writer.endObject();
      writer.assertComplete();
      await file.close();
      file = undefined;

      await this.privacy.recordSelfExport(userId);
      const stream = createReadStream(path);
      let cleaned = false;
      const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        void removeTemporaryExport(directory).finally(releaseSlot);
      };
      stream.once('close', cleanup);
      stream.once('error', cleanup);
      return new StreamableFile(stream, {
        type: 'application/json; charset=utf-8',
        disposition: `attachment; filename="${EXPORT_FILENAME}"`,
        length: writer.bytes,
      });
    } catch (error: unknown) {
      await closeQuietly(file);
      await removeTemporaryExport(directory);
      releaseSlot();
      if (error instanceof DataExportTooLargeError) {
        throw apiError(
          413,
          'data_export_too_large',
          'The data export exceeds the online download limit. Contact support to exercise this right.',
          error,
        );
      }
      throw apiError(
        503,
        'data_export_unavailable',
        'The complete data export is temporarily unavailable.',
        error,
      );
    }
  }

  private acquireSlot(): () => void {
    if (this.activeExports >= this.config.workloads.dataExportMaxConcurrency) {
      throw apiError(
        503,
        'data_export_busy',
        'The data export service is busy. Try again later.',
        undefined,
        30,
      );
    }
    this.activeExports += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeExports -= 1;
    };
  }
}

async function closeQuietly(file: FileHandle | undefined): Promise<void> {
  try {
    await file?.close();
  } catch {
    // The cleanup path must preserve the normalized export error.
  }
}

async function removeTemporaryExport(directory: string | undefined): Promise<void> {
  if (!directory) return;
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    // The random private directory contains only this response and is also cleared by the host temp policy.
  }
}
