-- Internal operational visibility, audited outbox recovery and richer administrator sessions.

ALTER TABLE outbox_event
  ADD COLUMN dead_lettered_at TIMESTAMPTZ,
  ADD COLUMN resolved_at TIMESTAMPTZ,
  ADD COLUMN resolved_by UUID REFERENCES user_account(user_id) ON DELETE SET NULL,
  ADD COLUMN resolution_reason TEXT;

UPDATE outbox_event
SET dead_lettered_at = COALESCE(dead_lettered_at, available_at, created_at)
WHERE status = 'dead_letter';

ALTER TABLE outbox_event
  DROP CONSTRAINT outbox_event_status_check,
  DROP CONSTRAINT chk_outbox_event_completion;

ALTER TABLE outbox_event
  ADD CONSTRAINT outbox_event_status_check CHECK (
    status IN ('pending', 'processing', 'completed', 'dead_letter', 'discarded')
  ),
  ADD CONSTRAINT chk_outbox_event_completion CHECK (
    (status = 'completed' AND processed_at IS NOT NULL)
    OR (status <> 'completed' AND processed_at IS NULL)
  ),
  ADD CONSTRAINT chk_outbox_event_dead_letter CHECK (
    (status IN ('dead_letter', 'discarded') AND dead_lettered_at IS NOT NULL)
    OR (status NOT IN ('dead_letter', 'discarded') AND dead_lettered_at IS NULL)
  ),
  ADD CONSTRAINT chk_outbox_event_resolution CHECK (
    (status = 'discarded'
      AND resolved_at IS NOT NULL
      AND resolution_reason IS NOT NULL
      AND char_length(resolution_reason) BETWEEN 3 AND 500)
    OR (status <> 'discarded'
      AND resolved_at IS NULL
      AND resolved_by IS NULL
      AND resolution_reason IS NULL)
  );

CREATE INDEX idx_outbox_event_dead_letter
  ON outbox_event(dead_lettered_at, id) WHERE status = 'dead_letter';
CREATE INDEX idx_outbox_event_discarded
  ON outbox_event(resolved_at, id) WHERE status = 'discarded';

CREATE TABLE outbox_operator_action (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  outbox_event_id UUID        REFERENCES outbox_event(id) ON DELETE SET NULL,
  administrator_id UUID       REFERENCES user_account(user_id) ON DELETE SET NULL,
  administrator_role TEXT     NOT NULL CHECK (administrator_role IN ('admin', 'superadmin')),
  event_type      TEXT        NOT NULL,
  action          TEXT        NOT NULL CHECK (action IN ('retry', 'discard')),
  reason          TEXT        NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX idx_outbox_operator_action_event
  ON outbox_operator_action(outbox_event_id, created_at DESC);
CREATE INDEX idx_outbox_operator_action_admin
  ON outbox_operator_action(administrator_id, created_at DESC);

CREATE TABLE maintenance_job_status (
  job_name             TEXT        PRIMARY KEY CHECK (job_name IN ('matches', 'photos', 'privacy', 'outbox')),
  run_id               UUID        NOT NULL,
  status               TEXT        NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  started_at           TIMESTAMPTZ NOT NULL,
  finished_at          TIMESTAMPTZ,
  last_succeeded_at    TIMESTAMPTZ,
  duration_ms          INTEGER     CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 86400000),
  processed_count      BIGINT      NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  last_error_code      TEXT        CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chk_maintenance_job_finished CHECK (
    (status = 'running' AND finished_at IS NULL AND duration_ms IS NULL)
    OR (status <> 'running' AND finished_at IS NOT NULL AND duration_ms IS NOT NULL)
  ),
  CONSTRAINT chk_maintenance_job_error CHECK (
    (status = 'failed' AND last_error_code IS NOT NULL)
    OR (status <> 'failed' AND last_error_code IS NULL)
  )
);

ALTER TABLE admin_auth_event
  DROP CONSTRAINT admin_auth_event_event_type_check;

ALTER TABLE admin_auth_event
  ADD CONSTRAINT admin_auth_event_event_type_check CHECK (event_type IN (
    'bootstrap_issued', 'bootstrap_registered', 'login_succeeded', 'credential_added',
    'credential_renamed', 'credential_revoked', 'session_revoked',
    'other_sessions_revoked', 'logout'
  ));

COMMENT ON TABLE maintenance_job_status IS
  'Last bounded execution outcome for each in-process maintenance job.';
COMMENT ON TABLE outbox_operator_action IS
  'Audited administrator decisions for dead-letter retries and safe discards.';
