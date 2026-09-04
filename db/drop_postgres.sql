-- =========================================
-- CLEAN RESET — DROP EXISTING OBJECTS
-- =========================================
DROP FUNCTION IF EXISTS fct_anonymize_user(UUID);
DROP FUNCTION IF EXISTS anonymize_user(UUID);
DROP FUNCTION IF EXISTS fct_require_live_account() CASCADE;
DROP FUNCTION IF EXISTS fct_require_live_match() CASCADE;
DROP TABLE IF EXISTS admin_auth_event CASCADE;
DROP TABLE IF EXISTS admin_session CASCADE;
DROP TABLE IF EXISTS admin_webauthn_challenge CASCADE;
DROP TABLE IF EXISTS admin_webauthn_bootstrap CASCADE;
DROP TABLE IF EXISTS admin_webauthn_credential CASCADE;
DROP TABLE IF EXISTS maintenance_job_status CASCADE;
DROP TABLE IF EXISTS outbox_operator_action CASCADE;
DROP TABLE IF EXISTS content_moderation_case CASCADE;
DROP TABLE IF EXISTS user_profile_answer CASCADE;
DROP TABLE IF EXISTS profile_question CASCADE;
DROP TABLE IF EXISTS account_erasure;
DROP FUNCTION IF EXISTS fct_cleanup_billing_identity() CASCADE;

DROP TABLE IF EXISTS stripe_webhook_event CASCADE;
DROP TABLE IF EXISTS billing_invoice CASCADE;
DROP TABLE IF EXISTS billing_checkout_session CASCADE;
DROP TABLE IF EXISTS billing_customer CASCADE;

DROP TABLE IF EXISTS notification_push_delivery CASCADE;
DROP TABLE IF EXISTS notification CASCADE;
DROP TABLE IF EXISTS device_token CASCADE;
DROP TABLE IF EXISTS account_deletion_token CASCADE;
DROP TABLE IF EXISTS user_report CASCADE;
DROP TABLE IF EXISTS user_block CASCADE;

DROP TABLE IF EXISTS refresh_tokens CASCADE;
DROP TABLE IF EXISTS refresh_token_family CASCADE;

DROP TABLE IF EXISTS continuation_usage CASCADE;

DROP TABLE IF EXISTS chat_message CASCADE;
DROP TABLE IF EXISTS match_state CASCADE;
DROP TABLE IF EXISTS match_init CASCADE;

DROP TABLE IF EXISTS user_trait CASCADE;
DROP TABLE IF EXISTS trait CASCADE;

DROP TABLE IF EXISTS user_presence CASCADE;
DROP TABLE IF EXISTS user_preferences CASCADE;
DROP TABLE IF EXISTS outbox_event CASCADE;
DROP TABLE IF EXISTS photo_upload_request CASCADE;
DROP TABLE IF EXISTS user_photo CASCADE;
DROP TABLE IF EXISTS user_profile CASCADE;

DROP FUNCTION IF EXISTS fct_check_user_age();
DROP FUNCTION IF EXISTS check_user_age();

DROP TABLE IF EXISTS data_access_log CASCADE;
DROP TABLE IF EXISTS data_subject_request CASCADE;
DROP TABLE IF EXISTS user_consent CASCADE;

DROP TABLE IF EXISTS otp_verification CASCADE;

DROP TABLE IF EXISTS user_subscription CASCADE;
DROP TABLE IF EXISTS subscription_plan_feature CASCADE;
DROP TABLE IF EXISTS subscription_plan CASCADE;

DROP TABLE IF EXISTS user_account CASCADE;
DROP FUNCTION IF EXISTS fct_erase_mobile_sessions();
DROP FUNCTION IF EXISTS fct_erase_notifications();
DROP TABLE IF EXISTS account_tombstone CASCADE;

-- Extensions are database-wide and may serve other schemas. Keep them installed.
