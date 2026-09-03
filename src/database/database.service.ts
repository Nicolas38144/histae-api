import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Injectable, Optional } from '@nestjs/common';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { Pool } from 'pg';
import { ConfigService } from '../config/config.service';
import { OperationalMetricsService } from '../operations/operational-metrics.service';

export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;

  constructor(config: ConfigService, @Optional() private readonly metrics?: OperationalMetricsService) {
    this.pool = new Pool(config.postgres);
  }

  async onModuleInit(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<T>> {
    return this.measure(() => this.pool.query<T>(text, values));
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.measure(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    });
  }

  poolStats(): { total: number; idle: number; waiting: number } {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  private measure<T>(operation: () => Promise<T>): Promise<T> {
    return this.metrics?.measure('postgres', operation) ?? operation();
  }
}
