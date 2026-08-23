-- Preserve trial history when a Stripe Customer is deleted outside account
-- erasure, while allowing a replacement Customer to be created safely.

ALTER TABLE billing_customer
  ADD COLUMN IF NOT EXISTS stripe_customer_deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_billing_customer_active_stripe_id
  ON billing_customer(stripe_customer_id)
  WHERE stripe_customer_deleted_at IS NULL;
