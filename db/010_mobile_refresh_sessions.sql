-- A family is one mobile login. Old rows cannot be linked retrospectively:
-- preserve each existing token as a separate family without extending its TTL.
CREATE TABLE refresh_token_family (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  last_refreshed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  UNIQUE (id, user_id),
  CONSTRAINT chk_refresh_family_revocation CHECK (
    (revoked_at IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL AND revocation_reason IN
      ('replay', 'logout', 'logout_all', 'user_revoked', 'banned', 'legacy_revoked'))
  )
);
CREATE INDEX idx_refresh_family_user_created
  ON refresh_token_family(user_id, created_at DESC, id DESC);
CREATE INDEX idx_refresh_family_expiry ON refresh_token_family(expires_at, id);

ALTER TABLE refresh_tokens
  ADD COLUMN family_id UUID,
  ADD COLUMN parent_token_id UUID,
  ADD COLUMN rotated_at TIMESTAMPTZ;

INSERT INTO refresh_token_family (id, user_id, created_at, last_refreshed_at, expires_at, revoked_at, revocation_reason)
SELECT id, user_id, created_at, created_at, expires_at,
  CASE WHEN revoked THEN statement_timestamp() END,
  CASE WHEN revoked THEN 'legacy_revoked' END
FROM refresh_tokens;
UPDATE refresh_tokens SET family_id = id;
ALTER TABLE refresh_tokens
  ALTER COLUMN family_id SET NOT NULL,
  ADD CONSTRAINT fk_refresh_family_owner FOREIGN KEY (family_id, user_id)
    REFERENCES refresh_token_family(id, user_id) ON DELETE CASCADE,
  ADD CONSTRAINT uq_refresh_id_family UNIQUE (id, family_id),
  ADD CONSTRAINT fk_refresh_parent FOREIGN KEY (parent_token_id, family_id)
    REFERENCES refresh_tokens(id, family_id) ON DELETE SET NULL (parent_token_id),
  ADD CONSTRAINT chk_refresh_not_own_parent CHECK (parent_token_id IS DISTINCT FROM id),
  ADD CONSTRAINT chk_refresh_rotation CHECK (rotated_at IS NULL OR revoked);
CREATE INDEX idx_refresh_tokens_family ON refresh_tokens(family_id);
CREATE UNIQUE INDEX uq_refresh_family_active ON refresh_tokens(family_id) WHERE revoked = false;
CREATE UNIQUE INDEX uq_refresh_token_child ON refresh_tokens(parent_token_id) WHERE parent_token_id IS NOT NULL;

-- Existing push registrations remain unbound until the client registers again.
ALTER TABLE device_token ADD COLUMN session_id UUID;
ALTER TABLE device_token ADD CONSTRAINT fk_device_session_owner
  FOREIGN KEY (session_id, user_id) REFERENCES refresh_token_family(id, user_id) ON DELETE CASCADE;
CREATE INDEX idx_device_session ON device_token(session_id) WHERE session_id IS NOT NULL;

-- The anonymization function predates families. Cover all its callers without
-- rewriting a deployed function or retaining new session metadata after erasure.
CREATE FUNCTION fct_erase_mobile_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM refresh_token_family WHERE user_id = NEW.user_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_erase_mobile_sessions
AFTER UPDATE OF deleted_at ON user_account
FOR EACH ROW WHEN (NEW.deleted_at IS NOT NULL)
EXECUTE FUNCTION fct_erase_mobile_sessions();
