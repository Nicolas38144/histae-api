-- Remove redundant or obsolete indexes identified after aligning the schema
-- with the queries currently executed by the API.
DROP INDEX IF EXISTS idx_user_account_phone_hash;
DROP INDEX IF EXISTS idx_refresh_tokens_jti;
DROP INDEX IF EXISTS idx_message_match_created;
DROP INDEX IF EXISTS idx_user_report_status;
DROP INDEX IF EXISTS idx_consent_user;
DROP INDEX IF EXISTS idx_match_init_last_message;
DROP INDEX IF EXISTS idx_user_account_active;
DROP INDEX IF EXISTS idx_user_account_to_anon;
DROP INDEX IF EXISTS idx_refresh_tokens_active;

-- Retention removes expired tokens globally. The former
-- (user_id, expires_at) partial index could not support that ordering because
-- user_id was its leading column.
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires
  ON refresh_tokens(expires_at);
