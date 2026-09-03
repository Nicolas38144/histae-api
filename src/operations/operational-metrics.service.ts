import type { OnModuleDestroy } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type {
  DependencyName,
  DependencySnapshot,
  HttpRouteSnapshot,
} from './operations.models';
import { DEPENDENCY_NAMES } from './operations.models';

const MAX_HTTP_ROUTES = 200;
const HTTP_DURATION_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, Number.POSITIVE_INFINITY];

type Counters = {
  calls: number;
  errors: number;
  totalDurationMs: number;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastErrorCode: string | null;
  lastOutcome: 'success' | 'error' | null;
};

type HttpCounters = {
  method: string;
  route: string;
  requests: number;
  errors: number;
  status401: number;
  status403: number;
  status429: number;
  status5xx: number;
  totalDurationMs: number;
  durationBuckets: number[];
};

@Injectable()
export class OperationalMetricsService implements OnModuleDestroy {
  readonly startedAt = new Date();
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  private readonly dependencies = new Map<DependencyName, Counters>();
  private readonly routes = new Map<string, HttpCounters>();

  constructor() {
    for (const dependency of DEPENDENCY_NAMES) this.dependencies.set(dependency, emptyCounters());
    this.eventLoopDelay.enable();
  }

  onModuleDestroy(): void {
    this.eventLoopDelay.disable();
  }

  async measure<T>(dependency: DependencyName, operation: () => Promise<T>): Promise<T> {
    const startedAt = process.hrtime.bigint();
    try {
      const result = await operation();
      this.recordDependency(dependency, true, elapsedMillis(startedAt), null);
      return result;
    } catch (error) {
      this.recordDependency(dependency, false, elapsedMillis(startedAt), operationalErrorCode(error));
      throw error;
    }
  }

  measureSync<T>(dependency: DependencyName, operation: () => T): T {
    const startedAt = process.hrtime.bigint();
    try {
      const result = operation();
      this.recordDependency(dependency, true, elapsedMillis(startedAt), null);
      return result;
    } catch (error) {
      this.recordDependency(dependency, false, elapsedMillis(startedAt), operationalErrorCode(error));
      throw error;
    }
  }

  recordHttp(method: string, route: string, statusCode: number, durationMs: number): void {
    const normalizedRoute = route.startsWith('/') ? route : '<unmatched>';
    const key = `${method} ${normalizedRoute}`;
    let counters = this.routes.get(key);
    if (!counters) {
      if (this.routes.size >= MAX_HTTP_ROUTES) return;
      counters = {
        method,
        route: normalizedRoute,
        requests: 0,
        errors: 0,
        status401: 0,
        status403: 0,
        status429: 0,
        status5xx: 0,
        totalDurationMs: 0,
        durationBuckets: HTTP_DURATION_BUCKETS.map(() => 0),
      };
      this.routes.set(key, counters);
    }
    counters.requests += 1;
    counters.errors += statusCode >= 400 ? 1 : 0;
    counters.status401 += statusCode === 401 ? 1 : 0;
    counters.status403 += statusCode === 403 ? 1 : 0;
    counters.status429 += statusCode === 429 ? 1 : 0;
    counters.status5xx += statusCode >= 500 ? 1 : 0;
    counters.totalDurationMs += durationMs;
    const bucket = HTTP_DURATION_BUCKETS.findIndex((upperBound) => durationMs <= upperBound);
    counters.durationBuckets[bucket] += 1;
  }

  httpSnapshot(): OperationalSnapshotHttp {
    const routes = [...this.routes.values()].map(toHttpSnapshot)
      .sort((left, right) => right.requests - left.requests || left.route.localeCompare(right.route));
    return {
      requests: sum(routes, 'requests'),
      errors: sum(routes, 'errors'),
      status_401: sum(routes, 'status_401'),
      status_403: sum(routes, 'status_403'),
      status_429: sum(routes, 'status_429'),
      status_5xx: sum(routes, 'status_5xx'),
      routes,
    };
  }

  dependencySnapshot(enabled: Partial<Record<DependencyName, boolean>>): Record<DependencyName, DependencySnapshot> {
    return Object.fromEntries(DEPENDENCY_NAMES.map((name) => {
      const counters = this.dependencies.get(name)!;
      const isEnabled = enabled[name] ?? true;
      return [name, {
        enabled: isEnabled,
        status: dependencyStatus(isEnabled, counters),
        calls: counters.calls,
        errors: counters.errors,
        average_duration_ms: average(counters.totalDurationMs, counters.calls),
        last_success_at: counters.lastSuccessAt?.toISOString() ?? null,
        last_error_at: counters.lastErrorAt?.toISOString() ?? null,
        last_error_code: counters.lastErrorCode,
      }];
    })) as Record<DependencyName, DependencySnapshot>;
  }

  runtimeSnapshot(): {
    uptime_seconds: number;
    memory_rss_bytes: number;
    heap_used_bytes: number;
    event_loop_delay_p95_ms: number;
  } {
    const memory = process.memoryUsage();
    const p95Nanos = this.eventLoopDelay.percentile(95);
    return {
      uptime_seconds: Math.floor(process.uptime()),
      memory_rss_bytes: memory.rss,
      heap_used_bytes: memory.heapUsed,
      event_loop_delay_p95_ms: Number.isFinite(p95Nanos) ? round(p95Nanos / 1_000_000) : 0,
    };
  }

  private recordDependency(
    dependency: DependencyName,
    succeeded: boolean,
    durationMs: number,
    errorCode: string | null,
  ): void {
    const counters = this.dependencies.get(dependency)!;
    counters.calls += 1;
    counters.totalDurationMs += durationMs;
    if (succeeded) {
      counters.lastSuccessAt = new Date();
      counters.lastOutcome = 'success';
    }
    else {
      counters.errors += 1;
      counters.lastErrorAt = new Date();
      counters.lastErrorCode = errorCode;
      counters.lastOutcome = 'error';
    }
  }
}

type OperationalSnapshotHttp = {
  requests: number;
  errors: number;
  status_401: number;
  status_403: number;
  status_429: number;
  status_5xx: number;
  routes: HttpRouteSnapshot[];
};

function emptyCounters(): Counters {
  return {
    calls: 0,
    errors: 0,
    totalDurationMs: 0,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorCode: null,
    lastOutcome: null,
  };
}

function toHttpSnapshot(counters: HttpCounters): HttpRouteSnapshot {
  return {
    method: counters.method,
    route: counters.route,
    requests: counters.requests,
    errors: counters.errors,
    status_401: counters.status401,
    status_403: counters.status403,
    status_429: counters.status429,
    status_5xx: counters.status5xx,
    average_duration_ms: average(counters.totalDurationMs, counters.requests),
    p95_duration_ms: percentileUpperBound(counters.durationBuckets, counters.requests, 0.95),
  };
}

function percentileUpperBound(buckets: number[], total: number, percentile: number): number {
  if (total === 0) return 0;
  const threshold = Math.ceil(total * percentile);
  let cumulative = 0;
  for (let index = 0; index < buckets.length; index += 1) {
    cumulative += buckets[index]!;
    if (cumulative >= threshold) {
      const bound = HTTP_DURATION_BUCKETS[index]!;
      return Number.isFinite(bound) ? bound : HTTP_DURATION_BUCKETS.at(-2)!;
    }
  }
  return HTTP_DURATION_BUCKETS.at(-2)!;
}

function sum<T>(items: T[], key: keyof T): number {
  return items.reduce((total, item) => total + Number(item[key]), 0);
}

function average(total: number, count: number): number {
  return count === 0 ? 0 : round(total / count);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function elapsedMillis(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

function operationalErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(error.code)) {
    return error.code;
  }
  if (typeof error === 'object' && error !== null && 'reason' in error
    && typeof error.reason === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(error.reason)) {
    return error.reason;
  }
  const name = error instanceof Error ? error.name : '';
  const normalized = name.replace(/Error$/, '').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  return /^[a-z][a-z0-9_]{0,63}$/.test(normalized) ? normalized : 'operation_failed';
}

function dependencyStatus(enabled: boolean, counters: Counters): DependencySnapshot['status'] {
  if (!enabled) return 'disabled';
  if (counters.lastOutcome === null) return 'unknown';
  return counters.lastOutcome === 'success' ? 'ok' : 'error';
}
