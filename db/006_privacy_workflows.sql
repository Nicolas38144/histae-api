-- Operational privacy workflows, access accountability and stronger erasure.

CREATE UNIQUE INDEX IF NOT EXISTS idx_dsr_one_open_per_type
  ON data_subject_request(user_id, type)
  WHERE status IN ('pending', 'in_progress');

ALTER TABLE data_access_log
  DROP CONSTRAINT IF EXISTS data_access_log_action_check;
ALTER TABLE data_access_log
  ADD CONSTRAINT data_access_log_action_check CHECK (action IN (
    'view_profile',
    'view_messages',
    'view_matches',
    'export_data',
    'admin_ban',
    'admin_unban',
    'admin_review_report',
    'admin_review_dsr',
    'system_anonymize',
    'system_export_portability'
  ));

CREATE TABLE IF NOT EXISTS account_tombstone (
  phone_number_hash TEXT PRIMARY KEY,
  reason TEXT NOT NULL CHECK (reason IN ('banned_account')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_tombstone_expiry ON account_tombstone(expires_at);

DROP INDEX IF EXISTS idx_match_init_to_purge;
CREATE INDEX idx_match_init_to_purge ON match_init(purge_after)
  WHERE status IN ('expired', 'ended');

CREATE OR REPLACE FUNCTION fct_anonymize_user(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO account_tombstone (phone_number_hash, reason, expires_at)
  SELECT phone_number_hash, 'banned_account', now() + INTERVAL '3 years'
  FROM user_account
  WHERE user_id = p_user_id AND is_banned = true
  ON CONFLICT (phone_number_hash) DO UPDATE
    SET expires_at = GREATEST(account_tombstone.expires_at, EXCLUDED.expires_at);

  INSERT INTO data_access_log (accessed_user_id, accessor_role, action, reason)
  VALUES (p_user_id, 'system', 'system_anonymize', 'Account erasure');

  UPDATE match_init
  SET status = 'ended', purge_after = COALESCE(purge_after, now() + INTERVAL '30 days')
  WHERE (user1_id = p_user_id OR user2_id = p_user_id)
    AND status IN ('active', 'awaiting_continuation', 'confirmed');

  UPDATE chat_message SET content = '[Message supprimé]'
  WHERE sender_id = p_user_id;

  DELETE FROM user_profile WHERE user_id = p_user_id;
  DELETE FROM user_preferences WHERE user_id = p_user_id;
  DELETE FROM user_trait WHERE user_id = p_user_id;
  DELETE FROM user_presence WHERE user_id = p_user_id;
  DELETE FROM refresh_tokens WHERE user_id = p_user_id;
  DELETE FROM device_token WHERE user_id = p_user_id;
  DELETE FROM notification WHERE user_id = p_user_id;
  DELETE FROM user_block WHERE blocker_id = p_user_id OR blocked_id = p_user_id;
  DELETE FROM user_subscription WHERE user_id = p_user_id;
  DELETE FROM continuation_usage WHERE user_id = p_user_id;
  DELETE FROM match_state WHERE user_id = p_user_id;

  UPDATE user_consent SET
    withdrawn_at = COALESCE(withdrawn_at, now()),
    ip_address = NULL,
    user_agent = NULL
  WHERE user_id = p_user_id;

  UPDATE user_account SET
    phone_number_hash = 'anon_' || encode(gen_random_bytes(16), 'hex'),
    phone_number_encrypted = '',
    is_banned = false,
    banned_at = NULL,
    banned_reason = NULL,
    banned_by = NULL,
    deleted_at = COALESCE(deleted_at, now()),
    anonymized_at = now()
  WHERE user_id = p_user_id;
END;
$$;
