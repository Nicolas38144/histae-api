import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { DatabaseService } from '../database/database.service';
import type { MaintenanceJobName, MaintenanceJobSnapshot, MaintenanceStatus } from './operations.models';

type MaintenanceRow = QueryResultRow & MaintenanceJobSnapshot;

@Injectable()
export class MaintenanceStatusRepository {
  constructor(private readonly database: DatabaseService) {}

  async start(jobName: MaintenanceJobName, runId: string, startedAt: Date): Promise<void> {
    await this.database.query(`
      INSERT INTO maintenance_job_status (job_name, run_id, status, started_at)
      VALUES ($1, $2, 'running', $3)
      ON CONFLICT (job_name) DO UPDATE
      SET run_id = EXCLUDED.run_id, status = 'running', started_at = EXCLUDED.started_at,
        finished_at = NULL, duration_ms = NULL, processed_count = 0,
        last_error_code = NULL, updated_at = clock_timestamp()
      WHERE maintenance_job_status.started_at <= EXCLUDED.started_at
    `, [jobName, runId, startedAt]);
  }

  async finish(input: {
    jobName: MaintenanceJobName;
    runId: string;
    status: Exclude<MaintenanceStatus, 'running'>;
    finishedAt: Date;
    durationMs: number;
    processedCount: number;
    errorCode: string | null;
  }): Promise<void> {
    await this.database.query(`
      UPDATE maintenance_job_status
      SET status = $3, finished_at = $4, duration_ms = $5, processed_count = $6,
        last_error_code = $7,
        last_succeeded_at = CASE WHEN $3 = 'succeeded' THEN $4 ELSE last_succeeded_at END,
        updated_at = clock_timestamp()
      WHERE job_name = $1 AND run_id = $2
    `, [
      input.jobName,
      input.runId,
      input.status,
      input.finishedAt,
      input.durationMs,
      input.processedCount,
      input.errorCode,
    ]);
  }

  async list(): Promise<MaintenanceJobSnapshot[]> {
    return (await this.database.query<MaintenanceRow>(`
      SELECT job_name, status, started_at, finished_at, last_succeeded_at,
        duration_ms, processed_count::int, last_error_code
      FROM maintenance_job_status
      ORDER BY job_name
    `)).rows;
  }
}
