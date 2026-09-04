CREATE TABLE account_erasure (
  request_id UUID PRIMARY KEY REFERENCES data_subject_request(id) ON DELETE CASCADE,
  user_id UUID NOT NULL UNIQUE REFERENCES user_account(user_id) ON DELETE CASCADE,
  step TEXT NOT NULL DEFAULT 'stripe' CHECK (step IN ('stripe', 'photos', 'scylla', 'postgres', 'completed')),
  scylla_partition SMALLINT NOT NULL DEFAULT 0 CHECK (scylla_partition BETWEEN 0 AND 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  CHECK ((step = 'completed') = (completed_at IS NOT NULL))
);

-- Persist the intent before customer creation; an interrupted response must not
-- make an external customer invisible to the erasure workflow.
ALTER TABLE billing_checkout_session
  ADD COLUMN customer_creation_started_at TIMESTAMPTZ,
  ADD COLUMN created_customer_id TEXT,
  ADD COLUMN customer_erased_at TIMESTAMPTZ;
CREATE INDEX idx_checkout_customer_erasure ON billing_checkout_session(user_id, id)
  WHERE customer_creation_started_at IS NOT NULL AND customer_erased_at IS NULL;

-- Coordinate short SQL writes with the irreversible account freeze. Deletes and
-- retention/redaction updates remain possible after the account has been disabled.
CREATE FUNCTION fct_require_live_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  account_ids UUID[] := '{}';
  column_name TEXT;
  account_row RECORD;
BEGIN
  FOREACH column_name IN ARRAY TG_ARGV LOOP
    account_ids := array_append(account_ids, (to_jsonb(NEW)->>column_name)::uuid);
  END LOOP;
  FOR account_row IN
    SELECT user_id, deleted_at FROM user_account WHERE user_id = ANY(account_ids)
    ORDER BY user_id FOR SHARE
  LOOP
    IF account_row.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0E01', MESSAGE = 'account_unavailable';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_live_profile BEFORE INSERT OR UPDATE ON user_profile
FOR EACH ROW EXECUTE FUNCTION fct_require_live_account('user_id');
CREATE TRIGGER trg_live_preferences BEFORE INSERT OR UPDATE ON user_preferences
FOR EACH ROW EXECUTE FUNCTION fct_require_live_account('user_id');
CREATE TRIGGER trg_live_presence BEFORE INSERT OR UPDATE OF user_id, latitude, longitude, updated_at ON user_presence
FOR EACH ROW EXECUTE FUNCTION fct_require_live_account('user_id');
CREATE TRIGGER trg_live_presence_freshness BEFORE UPDATE OF is_location_fresh ON user_presence
FOR EACH ROW WHEN (NEW.is_location_fresh) EXECUTE FUNCTION fct_require_live_account('user_id');
CREATE TRIGGER trg_live_trait BEFORE INSERT OR UPDATE ON user_trait
FOR EACH ROW EXECUTE FUNCTION fct_require_live_account('user_id');
CREATE TRIGGER trg_live_answer BEFORE INSERT OR UPDATE ON user_profile_answer
FOR EACH ROW EXECUTE FUNCTION fct_require_live_account('user_id');
CREATE TRIGGER trg_live_consent BEFORE INSERT ON user_consent
FOR EACH ROW EXECUTE FUNCTION fct_require_live_account('user_id');
CREATE TRIGGER trg_live_photo BEFORE INSERT OR UPDATE ON user_photo
FOR EACH ROW WHEN (NEW.status <> 'deleting') EXECUTE FUNCTION fct_require_live_account('user_id');
CREATE TRIGGER trg_live_photo_request BEFORE INSERT ON photo_upload_request
FOR EACH ROW EXECUTE FUNCTION fct_require_live_account('user_id');
CREATE TRIGGER trg_live_moderation BEFORE INSERT OR UPDATE ON content_moderation_case
FOR EACH ROW EXECUTE FUNCTION fct_require_live_account('user_id');
CREATE TRIGGER trg_live_device BEFORE INSERT OR UPDATE ON device_token
FOR EACH ROW EXECUTE FUNCTION fct_require_live_account('user_id');
CREATE TRIGGER trg_live_notification BEFORE INSERT ON notification
FOR EACH ROW EXECUTE FUNCTION fct_require_live_account('user_id');
CREATE TRIGGER trg_live_block BEFORE INSERT ON user_block
FOR EACH ROW EXECUTE FUNCTION fct_require_live_account('blocker_id', 'blocked_id');
CREATE TRIGGER trg_live_report BEFORE INSERT ON user_report
FOR EACH ROW EXECUTE FUNCTION fct_require_live_account('reporter_id');
CREATE TRIGGER trg_live_dsr BEFORE INSERT ON data_subject_request
FOR EACH ROW EXECUTE FUNCTION fct_require_live_account('user_id');
CREATE TRIGGER trg_live_checkout BEFORE INSERT ON billing_checkout_session
FOR EACH ROW EXECUTE FUNCTION fct_require_live_account('user_id');
CREATE TRIGGER trg_live_billing_customer BEFORE INSERT OR UPDATE ON billing_customer
FOR EACH ROW WHEN (NEW.stripe_customer_deleted_at IS NULL) EXECUTE FUNCTION fct_require_live_account('user_id');
CREATE TRIGGER trg_live_subscription BEFORE INSERT OR UPDATE ON user_subscription
FOR EACH ROW EXECUTE FUNCTION fct_require_live_account('user_id');
CREATE TRIGGER trg_live_match BEFORE INSERT ON match_init
FOR EACH ROW EXECUTE FUNCTION fct_require_live_account('user1_id', 'user2_id');

CREATE FUNCTION fct_require_live_match() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE participant RECORD;
BEGIN
  FOR participant IN
    SELECT account.user_id, account.deleted_at FROM user_account account
    JOIN match_init m ON account.user_id IN (m.user1_id, m.user2_id)
    WHERE m.id = NEW.match_id ORDER BY account.user_id FOR SHARE OF account
  LOOP
    IF participant.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0E01', MESSAGE = 'account_unavailable';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_live_message BEFORE INSERT ON chat_message
FOR EACH ROW EXECUTE FUNCTION fct_require_live_match();
CREATE TRIGGER trg_live_match_state BEFORE INSERT OR UPDATE ON match_state
FOR EACH ROW EXECUTE FUNCTION fct_require_live_match();

COMMENT ON TABLE account_erasure IS
  'Resumable erasure checkpoints, retained with the parent DSR (existing retention). No provider payload or secret.';
