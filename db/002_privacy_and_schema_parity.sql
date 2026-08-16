-- Privacy, retention and schema-parity migration.
-- This migration is additive so it is safe for databases where 001 was
-- already applied. It also makes a migrated database match db:reset.

CREATE INDEX IF NOT EXISTS idx_user_account_to_anon ON user_account(deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_consent (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  consent_type TEXT NOT NULL CHECK (consent_type IN (
    'terms_of_service',
    'privacy_policy',
    'sensitive_data_processing',
    'location_processing',
    'marketing'
  )),
  granted BOOLEAN NOT NULL,
  document_version TEXT,
  ip_address TEXT,
  user_agent TEXT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at TIMESTAMPTZ
);
ALTER TABLE user_consent ADD COLUMN IF NOT EXISTS document_version TEXT;
CREATE INDEX IF NOT EXISTS idx_consent_user ON user_consent(user_id);
CREATE INDEX IF NOT EXISTS idx_consent_type ON user_consent(user_id, consent_type);
CREATE INDEX IF NOT EXISTS idx_consent_active ON user_consent(user_id, consent_type)
  WHERE withdrawn_at IS NULL AND granted = true;

CREATE TABLE IF NOT EXISTS data_subject_request (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'access',
    'erasure',
    'portability',
    'rectification',
    'restriction',
    'objection'
  )),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',
    'in_progress',
    'completed',
    'rejected'
  )),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  handled_by UUID REFERENCES user_account(user_id) ON DELETE SET NULL,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_dsr_user ON data_subject_request(user_id);
CREATE INDEX IF NOT EXISTS idx_dsr_status ON data_subject_request(status);

CREATE TABLE IF NOT EXISTS data_access_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  accessed_user_id UUID NOT NULL,
  accessor_id UUID REFERENCES user_account(user_id) ON DELETE SET NULL,
  accessor_role TEXT,
  action TEXT NOT NULL CHECK (action IN (
    'view_profile',
    'view_messages',
    'export_data',
    'admin_ban',
    'admin_unban',
    'admin_review_report',
    'system_anonymize',
    'system_export_portability'
  )),
  reason TEXT,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dal_accessed_user ON data_access_log(accessed_user_id);
CREATE INDEX IF NOT EXISTS idx_dal_accessor ON data_access_log(accessor_id);
CREATE INDEX IF NOT EXISTS idx_dal_date ON data_access_log(accessed_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_presence_location ON user_presence(latitude, longitude)
  WHERE is_location_fresh = true;
CREATE INDEX IF NOT EXISTS idx_match_state_user ON match_state(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_active ON refresh_tokens(user_id, expires_at)
  WHERE revoked = false;

CREATE TABLE IF NOT EXISTS user_block (
  blocker_id UUID NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_user_block_blocked ON user_block(blocked_id);

CREATE INDEX IF NOT EXISTS idx_user_report_reported ON user_report(reported_id);
ALTER TABLE user_report ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_user_report_resolved ON user_report(resolved_at)
  WHERE status IN ('reviewed', 'dismissed');

CREATE INDEX IF NOT EXISTS idx_device_token_user ON device_token(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_user ON notification(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_unread ON notification(user_id, read_at) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notification_expire ON notification(expires_at);

CREATE OR REPLACE FUNCTION fct_anonymize_user(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE user_account SET
    phone_number_hash = 'anon_' || encode(gen_random_bytes(16), 'hex'),
    phone_number_encrypted = '',
    is_banned = false,
    banned_at = NULL,
    banned_reason = NULL,
    deleted_at = COALESCE(deleted_at, now()),
    anonymized_at = now()
  WHERE user_id = p_user_id;

  DELETE FROM user_profile WHERE user_id = p_user_id;
  DELETE FROM user_preferences WHERE user_id = p_user_id;
  DELETE FROM user_trait WHERE user_id = p_user_id;
  DELETE FROM user_presence WHERE user_id = p_user_id;
  DELETE FROM refresh_tokens WHERE user_id = p_user_id;
  DELETE FROM device_token WHERE user_id = p_user_id;
  DELETE FROM notification WHERE user_id = p_user_id;
  DELETE FROM user_block WHERE blocker_id = p_user_id OR blocked_id = p_user_id;

  UPDATE chat_message SET content = '[Message supprimé]'
  WHERE sender_id = p_user_id;

  UPDATE user_consent SET withdrawn_at = COALESCE(withdrawn_at, now())
  WHERE user_id = p_user_id AND granted = true AND withdrawn_at IS NULL;
END;
$$;
