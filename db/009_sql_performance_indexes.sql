-- Query-path indexes for discovery, keyset pagination, exports and bounded
-- retention jobs. Keep these aligned with the predicates and sort orders used
-- by the repositories; several replace narrower indexes rather than duplicate
-- them.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX idx_user_account_active_created
  ON user_account(created_at DESC, user_id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_user_profile_discovery
  ON user_profile(sex, birthdate, user_id)
  WHERE sex IS NOT NULL;

CREATE INDEX idx_user_profile_firstname_trgm
  ON user_profile USING gin (firstname gin_trgm_ops);

DROP INDEX idx_user_presence_location;
CREATE INDEX idx_user_presence_location
  ON user_presence(latitude, longitude)
  INCLUDE (user_id, updated_at)
  WHERE is_location_fresh = true;

CREATE INDEX idx_user_presence_updated
  ON user_presence(updated_at, user_id);

CREATE INDEX idx_user_photo_reconciliation
  ON user_photo(updated_at DESC, id DESC)
  WHERE status IN ('pending', 'processing', 'deleting');

CREATE INDEX idx_content_moderation_updated
  ON content_moderation_case(updated_at DESC, id DESC);

CREATE INDEX idx_content_moderation_type_updated
  ON content_moderation_case(content_type, updated_at DESC, id DESC);

CREATE INDEX idx_match_init_user1_activity
  ON match_init(user1_id, (COALESCE(last_message_at, created_at)) DESC, id DESC)
  WHERE status <> 'ended';

CREATE INDEX idx_match_init_user2_activity
  ON match_init(user2_id, (COALESCE(last_message_at, created_at)) DESC, id DESC)
  WHERE status <> 'ended';

CREATE INDEX idx_chat_message_sender_created
  ON chat_message(sender_id, created_at, id);

DROP INDEX idx_chat_message_match_unread;
CREATE INDEX idx_chat_message_match_unread
  ON chat_message(match_id, created_at DESC, id DESC)
  INCLUDE (sender_id)
  WHERE read_at IS NULL;

CREATE INDEX idx_user_report_reporter_created
  ON user_report(reporter_id, created_at, id);

CREATE INDEX idx_user_block_blocker_created
  ON user_block(blocker_id, created_at DESC, blocked_id);

DROP INDEX idx_consent_type;
CREATE INDEX idx_consent_type
  ON user_consent(user_id, consent_type, event_sequence DESC);

CREATE INDEX idx_consent_withdrawn
  ON user_consent(withdrawn_at, id)
  WHERE withdrawn_at IS NOT NULL;

DROP INDEX idx_dsr_user;
CREATE INDEX idx_dsr_user
  ON data_subject_request(user_id, requested_at DESC, id DESC);

DROP INDEX idx_dsr_status;
CREATE INDEX idx_dsr_status
  ON data_subject_request(status, requested_at, id);

CREATE INDEX idx_dsr_requested
  ON data_subject_request(requested_at, id);

CREATE INDEX idx_dsr_completed
  ON data_subject_request(completed_at, id)
  WHERE status IN ('completed', 'rejected') AND completed_at IS NOT NULL;

DROP INDEX idx_dal_accessed_user;
CREATE INDEX idx_dal_accessed_user
  ON data_access_log(accessed_user_id, accessed_at DESC, id DESC);

DROP INDEX idx_admin_auth_event_user;
CREATE INDEX idx_admin_auth_event_user
  ON admin_auth_event(user_id, created_at DESC, id DESC);

CREATE INDEX idx_admin_auth_event_created
  ON admin_auth_event(created_at, id);

CREATE INDEX idx_admin_webauthn_challenge_consumed
  ON admin_webauthn_challenge(expires_at, id)
  WHERE consumed_at IS NOT NULL;

CREATE INDEX idx_admin_webauthn_bootstrap_consumed
  ON admin_webauthn_bootstrap(expires_at, id)
  WHERE consumed_at IS NOT NULL;

CREATE INDEX idx_outbox_operator_action_created
  ON outbox_operator_action(created_at, id);

CREATE INDEX idx_user_subscription_plan_updated
  ON user_subscription(plan, updated_at);

DROP INDEX idx_account_tombstone_expiry;
CREATE INDEX idx_account_tombstone_expiry
  ON account_tombstone(expires_at, phone_number_hash);

DROP INDEX idx_otp_expires;
CREATE INDEX idx_otp_expires
  ON otp_verification(expires_at, id);

DROP INDEX idx_refresh_tokens_expires;
CREATE INDEX idx_refresh_tokens_expires
  ON refresh_tokens(expires_at, id);

DROP INDEX idx_notification_expire;
CREATE INDEX idx_notification_expire
  ON notification(expires_at, id);

DROP INDEX idx_account_deletion_token_expires;
CREATE INDEX idx_account_deletion_token_expires
  ON account_deletion_token(expires_at, id);

DROP INDEX idx_dal_date;
CREATE INDEX idx_dal_date
  ON data_access_log(accessed_at, id);

DROP INDEX idx_user_report_resolved;
CREATE INDEX idx_user_report_resolved
  ON user_report(resolved_at, id)
  WHERE status IN ('reviewed', 'dismissed');

DROP INDEX idx_admin_session_expiry;
CREATE INDEX idx_admin_session_expiry
  ON admin_session(absolute_expires_at, id);

CREATE INDEX idx_admin_session_revoked
  ON admin_session(revoked_at, id)
  WHERE revoked_at IS NOT NULL;
