export const DEPENDENCY_NAMES = [
  'postgres',
  'redis',
  'scylla',
  'object_storage',
  'sweego',
  'stripe',
] as const;
export type DependencyName = typeof DEPENDENCY_NAMES[number];

export const MAINTENANCE_JOB_NAMES = ['matches', 'photos', 'privacy', 'outbox'] as const;
export type MaintenanceJobName = typeof MAINTENANCE_JOB_NAMES[number];
export type MaintenanceStatus = 'running' | 'succeeded' | 'failed' | 'skipped';

export type MaintenanceJobSnapshot = {
  job_name: MaintenanceJobName;
  status: MaintenanceStatus;
  started_at: Date;
  finished_at: Date | null;
  last_succeeded_at: Date | null;
  duration_ms: number | null;
  processed_count: number;
  last_error_code: string | null;
};

export type DependencySnapshot = {
  enabled: boolean;
  status: 'disabled' | 'unknown' | 'ok' | 'error';
  calls: number;
  errors: number;
  average_duration_ms: number;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error_code: string | null;
};

export type MaintenanceJobOperationalView = {
  job_name: MaintenanceJobName;
  status: MaintenanceStatus | null;
  started_at: Date | null;
  finished_at: Date | null;
  last_succeeded_at: Date | null;
  duration_ms: number | null;
  processed_count: number;
  last_error_code: string | null;
  missing: boolean;
  overdue: boolean;
};

export type HttpRouteSnapshot = {
  method: string;
  route: string;
  requests: number;
  errors: number;
  status_401: number;
  status_403: number;
  status_429: number;
  status_5xx: number;
  average_duration_ms: number;
  p95_duration_ms: number;
};

export type OperationalSnapshot = {
  collected_at: string;
  since: string;
  runtime: {
    uptime_seconds: number;
    memory_rss_bytes: number;
    heap_used_bytes: number;
    event_loop_delay_p95_ms: number;
  };
  http: {
    requests: number;
    errors: number;
    status_401: number;
    status_403: number;
    status_429: number;
    status_5xx: number;
    routes: HttpRouteSnapshot[];
  };
  dependencies: Record<DependencyName, DependencySnapshot>;
  postgres_pool: { total: number; idle: number; waiting: number };
  outbox: {
    pending: number;
    processing: number;
    dead_letter: number;
    discarded: number;
    oldest_pending_at: Date | null;
  };
  maintenance: MaintenanceJobOperationalView[];
};
