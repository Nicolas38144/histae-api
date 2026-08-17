-- Real SMS delivery metadata and application-level idempotency for OTP requests.
ALTER TABLE otp_verification
  ADD COLUMN idempotency_key UUID,
  ADD COLUMN delivery_status TEXT,
  ADD COLUMN provider TEXT,
  ADD COLUMN provider_transaction_id TEXT,
  ADD COLUMN provider_message_id TEXT,
  ADD COLUMN delivery_error_code TEXT,
  ADD COLUMN sent_at TIMESTAMPTZ;

UPDATE otp_verification
SET idempotency_key = uuid_generate_v4(),
    delivery_status = 'sent',
    provider = 'legacy',
    sent_at = created_at;

ALTER TABLE otp_verification
  ALTER COLUMN idempotency_key SET NOT NULL,
  ALTER COLUMN idempotency_key SET DEFAULT uuid_generate_v4(),
  ALTER COLUMN delivery_status SET NOT NULL,
  ALTER COLUMN delivery_status SET DEFAULT 'pending',
  ALTER COLUMN provider SET NOT NULL,
  ALTER COLUMN provider SET DEFAULT 'sweego',
  ADD CONSTRAINT chk_otp_delivery_status
    CHECK (delivery_status IN ('pending', 'sent', 'failed'));

CREATE UNIQUE INDEX idx_otp_idempotency ON otp_verification(idempotency_key);
CREATE INDEX idx_otp_phone_usable ON otp_verification(phone_number_hash, created_at DESC) WHERE delivery_status = 'sent' AND used = false;
