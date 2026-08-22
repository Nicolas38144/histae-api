-- Mobile client contract: message idempotency, efficient unread queries,
-- device metadata, and one-time account deletion confirmation tokens.

ALTER TABLE chat_message
  ADD COLUMN IF NOT EXISTS idempotency_key UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_message_sender_idempotency
  ON chat_message(sender_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chat_message_match_unread
  ON chat_message(match_id, created_at DESC, id DESC)
  WHERE read_at IS NULL;

ALTER TABLE device_token
  ADD COLUMN IF NOT EXISTS app_version TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_token_app_version_length'
  ) THEN
    ALTER TABLE device_token
      ADD CONSTRAINT device_token_app_version_length
      CHECK (app_version IS NULL OR octet_length(app_version) BETWEEN 1 AND 50);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS account_deletion_token (
  id         UUID        PRIMARY KEY,
  user_id    UUID        NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  token_hash TEXT        NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_account_deletion_token_expires
  ON account_deletion_token(expires_at);
