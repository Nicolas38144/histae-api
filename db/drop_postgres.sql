-- =========================================
-- CLEAN RESET — DROP EXISTING OBJECTS
-- =========================================
DROP FUNCTION IF EXISTS fct_anonymize_user(UUID);

DROP TABLE IF EXISTS notification CASCADE;
DROP TABLE IF EXISTS device_token CASCADE;
DROP TABLE IF EXISTS user_report CASCADE;
DROP TABLE IF EXISTS user_block CASCADE;

DROP TABLE IF EXISTS refresh_tokens CASCADE;

DROP TABLE IF EXISTS continuation_usage CASCADE;

DROP TABLE IF EXISTS chat_message CASCADE;
DROP TABLE IF EXISTS match_state CASCADE;
DROP TABLE IF EXISTS match_init CASCADE;

DROP TABLE IF EXISTS user_trait CASCADE;
DROP TABLE IF EXISTS trait CASCADE;

DROP TABLE IF EXISTS user_presence CASCADE;
DROP TABLE IF EXISTS user_preferences CASCADE;
DROP TABLE IF EXISTS user_profile CASCADE;

DROP FUNCTION IF EXISTS fct_check_user_age();

DROP TABLE IF EXISTS data_access_log CASCADE;
DROP TABLE IF EXISTS data_subject_request CASCADE;
DROP TABLE IF EXISTS user_consent CASCADE;

DROP TABLE IF EXISTS otp_verification CASCADE;

DROP TABLE IF EXISTS user_subscription CASCADE;
DROP TABLE IF EXISTS subscription_plan_feature CASCADE;
DROP TABLE IF EXISTS subscription_plan CASCADE;

DROP TABLE IF EXISTS user_account CASCADE;
DROP TABLE IF EXISTS account_tombstone CASCADE;

DROP EXTENSION IF EXISTS "uuid-ossp";
DROP EXTENSION IF EXISTS "pgcrypto";
