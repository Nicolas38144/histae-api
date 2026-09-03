import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Injectable, Optional } from '@nestjs/common';
import type { ArrayOrObject, QueryOptions, types } from 'cassandra-driver';
import { ConfigService } from '../config/config.service';
import { createScyllaClient } from './scylla.client';
import { OperationalMetricsService } from '../operations/operational-metrics.service';

@Injectable()
export class ScyllaService implements OnModuleInit, OnModuleDestroy {
  private readonly client;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly metrics?: OperationalMetricsService,
  ) {
    this.client = createScyllaClient(config.scylla);
  }

  get enabled(): boolean {
    return this.config.scylla.enabled;
  }

  async onModuleInit(): Promise<void> {
    if (this.enabled) await this.client.connect();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.enabled) await this.client.shutdown();
  }

  async execute(query: string, params: ArrayOrObject = [], options: QueryOptions = {}): Promise<types.ResultSet> {
    if (!this.enabled) throw new ScyllaUnavailableError('ScyllaDB is disabled');
    try {
      const operation = () => this.client.execute(query, params, { prepare: true, ...options });
      return await (this.metrics?.measure('scylla', operation) ?? operation());
    } catch (error) {
      throw new ScyllaUnavailableError('ScyllaDB query failed', { cause: error });
    }
  }

  async check(): Promise<void> {
    if (!this.enabled) return;
    await this.execute('SELECT release_version FROM system.local', [], { prepare: false, isIdempotent: true });
  }
}

export class ScyllaUnavailableError extends Error {}
