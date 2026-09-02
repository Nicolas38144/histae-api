-- Durable photo-upload idempotency and transactional outbox.

CREATE TABLE photo_upload_request (
  user_id           UUID        NOT NULL REFERENCES user_profile(user_id) ON DELETE CASCADE,
  idempotency_key   UUID        NOT NULL,
  request_sha256    BYTEA       NOT NULL CHECK (octet_length(request_sha256) = 32),
  photo_id          UUID        UNIQUE REFERENCES user_photo(id) ON DELETE SET NULL,
  status            TEXT        NOT NULL CHECK (status IN ('processing', 'completed', 'consumed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours'),
  PRIMARY KEY (user_id, idempotency_key),
  CONSTRAINT chk_photo_upload_request_expiry CHECK (expires_at > created_at)
);

CREATE INDEX idx_photo_upload_request_expires
  ON photo_upload_request(expires_at, user_id, idempotency_key);

COMMENT ON TABLE photo_upload_request IS 'Short-lived idempotency records for profile-photo uploads; request hashes never contain the source image.';
COMMENT ON COLUMN photo_upload_request.request_sha256 IS 'SHA-256 of the filename, declared MIME type and source bytes.';

CREATE TABLE outbox_event (
  id               UUID        PRIMARY KEY,
  event_type       TEXT        NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  aggregate_id     UUID        NOT NULL,
  payload          JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  status           TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'processing', 'completed', 'dead_letter')),
  attempts         SMALLINT    NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  available_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at        TIMESTAMPTZ,
  locked_by        UUID,
  last_error_code  TEXT        CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at     TIMESTAMPTZ,
  UNIQUE (event_type, aggregate_id),
  CONSTRAINT chk_outbox_event_lock CHECK (
    (status = 'processing' AND locked_at IS NOT NULL AND locked_by IS NOT NULL)
    OR
    (status <> 'processing' AND locked_at IS NULL AND locked_by IS NULL)
  ),
  CONSTRAINT chk_outbox_event_completion CHECK (
    (status = 'completed' AND processed_at IS NOT NULL)
    OR
    (status <> 'completed' AND processed_at IS NULL)
  )
);

CREATE INDEX idx_outbox_event_due
  ON outbox_event(available_at, created_at, id)
  WHERE status = 'pending';

CREATE INDEX idx_outbox_event_stale_lock
  ON outbox_event(locked_at, id)
  WHERE status = 'processing';

CREATE INDEX idx_outbox_event_completed
  ON outbox_event(processed_at, id)
  WHERE status = 'completed';

COMMENT ON TABLE outbox_event IS 'Durable transactional events claimed by bounded workers with retry and dead-letter handling.';
COMMENT ON COLUMN outbox_event.payload IS 'Non-sensitive versioned event data; handlers should prefer aggregate identifiers over copied personal data.';
