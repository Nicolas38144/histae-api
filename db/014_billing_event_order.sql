-- Prevent an out-of-order Stripe invoice event from regressing the local ledger.

ALTER TABLE billing_invoice
  ADD COLUMN IF NOT EXISTS provider_event_created_at TIMESTAMPTZ;

UPDATE billing_invoice
SET provider_event_created_at = updated_at
WHERE provider_event_created_at IS NULL;
