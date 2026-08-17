-- Preserve a single usable OTP per phone before enforcing the invariant.
LOCK TABLE otp_verification IN SHARE ROW EXCLUSIVE MODE;

WITH ranked_usable_otps AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY phone_number_hash
           ORDER BY sent_at DESC NULLS LAST, created_at DESC, id DESC
         ) AS position
  FROM otp_verification
  WHERE delivery_status = 'sent' AND used = false
)
UPDATE otp_verification AS otp
SET used = true
FROM ranked_usable_otps AS ranked
WHERE otp.id = ranked.id AND ranked.position > 1;

DROP INDEX IF EXISTS idx_otp_phone_usable;

CREATE UNIQUE INDEX idx_otp_one_usable_per_phone
  ON otp_verification(phone_number_hash)
  WHERE delivery_status = 'sent' AND used = false;
