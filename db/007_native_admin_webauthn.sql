-- Administrator authentication is deliberately separate from mobile SMS authentication.
-- Only public WebAuthn material and hashed bearer secrets are persisted.

CREATE TABLE admin_webauthn_bootstrap (
  id          UUID        PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  secret_hash BYTEA       NOT NULL CHECK (octet_length(secret_hash) = 32),
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX uq_admin_webauthn_bootstrap_active_user
  ON admin_webauthn_bootstrap(user_id) WHERE consumed_at IS NULL;
CREATE INDEX idx_admin_webauthn_bootstrap_expiry
  ON admin_webauthn_bootstrap(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE admin_webauthn_credential (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID        NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  credential_id     TEXT        NOT NULL UNIQUE,
  public_key        BYTEA       NOT NULL,
  counter           BIGINT      NOT NULL DEFAULT 0 CHECK (counter BETWEEN 0 AND 4294967295),
  device_type       TEXT        NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
  backed_up         BOOLEAN     NOT NULL,
  transports        TEXT[]      NOT NULL DEFAULT ARRAY[]::text[],
  aaguid             UUID,
  name               TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_used_at       TIMESTAMPTZ,
  revoked_at         TIMESTAMPTZ,
  CONSTRAINT chk_admin_webauthn_credential_id CHECK (
    char_length(credential_id) BETWEEN 1 AND 2048
    AND credential_id ~ '^[A-Za-z0-9_-]+$'
  ),
  CONSTRAINT chk_admin_webauthn_public_key CHECK (
    octet_length(public_key) BETWEEN 1 AND 8192
  ),
  CONSTRAINT chk_admin_webauthn_transports CHECK (
    transports <@ ARRAY['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']::text[]
  ),
  CONSTRAINT chk_admin_webauthn_name CHECK (
    name = btrim(name)
    AND char_length(name) BETWEEN 1 AND 100
    AND octet_length(name) <= 200
  )
);
CREATE INDEX idx_admin_webauthn_credential_user
  ON admin_webauthn_credential(user_id, created_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE admin_webauthn_challenge (
  id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  purpose        TEXT        NOT NULL CHECK (purpose IN ('bootstrap_registration', 'additional_registration', 'authentication')),
  challenge_hash BYTEA       NOT NULL CHECK (octet_length(challenge_hash) = 32),
  user_id        UUID        REFERENCES user_account(user_id) ON DELETE CASCADE,
  bootstrap_id   UUID        REFERENCES admin_webauthn_bootstrap(id) ON DELETE CASCADE,
  expires_at     TIMESTAMPTZ NOT NULL,
  consumed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at),
  CONSTRAINT chk_admin_webauthn_challenge_owner CHECK (
    (purpose = 'authentication' AND user_id IS NULL AND bootstrap_id IS NULL)
    OR (purpose = 'additional_registration' AND user_id IS NOT NULL AND bootstrap_id IS NULL)
    OR (purpose = 'bootstrap_registration' AND user_id IS NOT NULL AND bootstrap_id IS NOT NULL)
  )
);
CREATE INDEX idx_admin_webauthn_challenge_expiry
  ON admin_webauthn_challenge(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE admin_session (
  id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID        NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  credential_id       UUID        NOT NULL REFERENCES admin_webauthn_credential(id) ON DELETE CASCADE,
  token_hash          BYTEA       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  authenticated_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  idle_expires_at     TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (idle_expires_at > created_at),
  CHECK (absolute_expires_at >= idle_expires_at)
);
CREATE INDEX idx_admin_session_user
  ON admin_session(user_id, created_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX idx_admin_session_expiry
  ON admin_session(idle_expires_at, absolute_expires_at) WHERE revoked_at IS NULL;

CREATE TABLE admin_auth_event (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID        NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  credential_id UUID        REFERENCES admin_webauthn_credential(id) ON DELETE SET NULL,
  session_id    UUID        REFERENCES admin_session(id) ON DELETE SET NULL,
  event_type    TEXT        NOT NULL CHECK (event_type IN (
    'bootstrap_issued', 'bootstrap_registered', 'login_succeeded', 'credential_added',
    'credential_revoked', 'other_sessions_revoked', 'logout'
  )),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX idx_admin_auth_event_user
  ON admin_auth_event(user_id, created_at DESC);

COMMENT ON TABLE admin_webauthn_credential IS
  'Public WebAuthn credentials for administrators; private keys never leave authenticators.';
COMMENT ON TABLE admin_session IS
  'Short, revocable administrator sessions. Only SHA-256 token hashes are persisted.';
