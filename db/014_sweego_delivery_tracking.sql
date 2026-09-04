-- Deploy with all OTP writers stopped: the old `sent` meant HTTP acceptance.
ALTER TABLE otp_verification DROP CONSTRAINT chk_otp_delivery_status;
DROP INDEX idx_otp_one_usable_per_phone;
UPDATE otp_verification SET delivery_status = 'accepted' WHERE delivery_status = 'sent';
ALTER TABLE otp_verification
  ADD CONSTRAINT chk_otp_delivery_status
    CHECK (delivery_status IN ('pending', 'accepted', 'sent', 'failed', 'unknown')),
  ADD COLUMN attempt_number BIGINT,
  ADD COLUMN settlement_deadline TIMESTAMPTZ,
  ADD COLUMN provider_sent_at TIMESTAMPTZ,
  ADD COLUMN failed_at TIMESTAMPTZ,
  ADD COLUMN last_webhook_at TIMESTAMPTZ;

-- Heap order is not chronological; preserve the ordering of attempts already present.
WITH ordered AS (SELECT id, row_number() OVER (ORDER BY created_at, id) AS ordinal FROM otp_verification)
UPDATE otp_verification otp SET attempt_number = ordered.ordinal FROM ordered WHERE ordered.id = otp.id;
ALTER TABLE otp_verification ALTER COLUMN attempt_number SET NOT NULL;
ALTER TABLE otp_verification ALTER COLUMN attempt_number ADD GENERATED ALWAYS AS IDENTITY;
SELECT setval(pg_get_serial_sequence('otp_verification', 'attempt_number'),
  COALESCE((SELECT max(attempt_number) FROM otp_verification), 1), EXISTS(SELECT 1 FROM otp_verification));

UPDATE otp_verification SET settlement_deadline = created_at + INTERVAL '35 seconds';
ALTER TABLE otp_verification ALTER COLUMN settlement_deadline SET NOT NULL;
ALTER TABLE otp_verification ALTER COLUMN settlement_deadline
  SET DEFAULT (clock_timestamp() + INTERVAL '35 seconds');
CREATE UNIQUE INDEX idx_otp_one_usable_per_phone ON otp_verification(phone_number_hash)
  WHERE delivery_status IN ('accepted', 'sent') AND used = false;
CREATE INDEX idx_otp_phone_attempt ON otp_verification(phone_number_hash, attempt_number DESC);

COMMENT ON COLUMN otp_verification.sent_at IS
  'First acceptance/enqueue confirmation observed locally; not proof of handset delivery.';
COMMENT ON COLUMN otp_verification.provider_sent_at IS
  'Local receipt time of authenticated sms_sent; Sweego does not document this as handset delivery.';
-- No callback body, phone, OTP, or event log is stored. Existing OTP expiry purge applies.
