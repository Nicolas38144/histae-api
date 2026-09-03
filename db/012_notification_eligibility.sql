-- Internal source context only: never project these fields into the mobile payload or FCM.
-- Legacy billing notifications remain readable, but cannot be pushed without verified context.
ALTER TABLE notification
  ADD COLUMN billing_reference TEXT,
  ADD COLUMN billing_trial_ends_at TIMESTAMPTZ,
  ADD CONSTRAINT chk_notification_billing_context CHECK (
    (billing_reference IS NULL AND billing_trial_ends_at IS NULL)
    OR (type = 'billing_payment_failed' AND billing_reference IS NOT NULL
      AND billing_reference ~ '^in_[A-Za-z0-9]+$' AND billing_trial_ends_at IS NULL)
    OR (type = 'subscription_trial_ending' AND billing_reference IS NOT NULL
      AND billing_reference ~ '^sub_[A-Za-z0-9]+$' AND billing_trial_ends_at IS NOT NULL)
  );

-- fct_anonymize_user deletes notifications before its final account update.
-- A writer holding FOR SHARE can commit between those steps. Once the final update
-- holds the conflicting account lock, remove those late rows in the same transaction.
-- Do not introduce an account-before-match lock inversion into the legacy erasure flow.
CREATE FUNCTION fct_erase_notifications() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM notification WHERE user_id = NEW.user_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_erase_notifications
AFTER UPDATE OF deleted_at ON user_account
FOR EACH ROW WHEN (NEW.deleted_at IS NOT NULL)
EXECUTE FUNCTION fct_erase_notifications();
