-- Stripe Billing contract: customer mapping, idempotent Checkout attempts,
-- verified webhook ledger, invoice ledger, and subscription projection.

ALTER TABLE user_subscription
  ADD COLUMN IF NOT EXISTS provider TEXT,
  ADD COLUMN IF NOT EXISTS provider_subscription_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_price_id TEXT,
  ADD COLUMN IF NOT EXISTS billing_period TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS current_period_starts_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_event_created_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_subscription_provider') THEN
    ALTER TABLE user_subscription ADD CONSTRAINT user_subscription_provider
      CHECK (provider IS NULL OR provider = 'stripe');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_subscription_provider_id') THEN
    ALTER TABLE user_subscription ADD CONSTRAINT user_subscription_provider_id
      CHECK (provider_subscription_id IS NULL OR provider_subscription_id ~ '^sub_[A-Za-z0-9]+$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_subscription_price_id') THEN
    ALTER TABLE user_subscription ADD CONSTRAINT user_subscription_price_id
      CHECK (provider_price_id IS NULL OR provider_price_id ~ '^price_[A-Za-z0-9]+$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_subscription_billing_period') THEN
    ALTER TABLE user_subscription ADD CONSTRAINT user_subscription_billing_period
      CHECK (billing_period IS NULL OR billing_period IN ('monthly', 'annual'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_subscription_status') THEN
    ALTER TABLE user_subscription ADD CONSTRAINT user_subscription_status
      CHECK (status IS NULL OR status IN ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'));
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_subscription_provider_id
  ON user_subscription(provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing_customer (
  user_id            UUID        PRIMARY KEY REFERENCES user_account(user_id) ON DELETE CASCADE,
  stripe_customer_id TEXT        NOT NULL UNIQUE CHECK (stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  trial_used_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_checkout_session (
  id                UUID        PRIMARY KEY,
  user_id           UUID        NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  idempotency_key   UUID        NOT NULL,
  billing_period    TEXT        NOT NULL CHECK (billing_period IN ('monthly', 'annual')),
  stripe_session_id TEXT        UNIQUE CHECK (stripe_session_id IS NULL OR stripe_session_id ~ '^cs_(test_|live_)?[A-Za-z0-9]+$'),
  checkout_url      TEXT,
  status            TEXT        NOT NULL CHECK (status IN ('creating', 'open', 'completed', 'expired', 'failed')),
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  CHECK (checkout_url IS NULL OR octet_length(checkout_url) <= 4096)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_checkout_one_live_per_user
  ON billing_checkout_session(user_id)
  WHERE status IN ('creating', 'open');
CREATE INDEX IF NOT EXISTS idx_billing_checkout_expiry
  ON billing_checkout_session(expires_at)
  WHERE status IN ('creating', 'open');

CREATE TABLE IF NOT EXISTS stripe_webhook_event (
  id                TEXT        PRIMARY KEY CHECK (id ~ '^evt_[A-Za-z0-9]+$'),
  event_type        TEXT        NOT NULL,
  object_id         TEXT,
  livemode          BOOLEAN     NOT NULL,
  api_version       TEXT,
  stripe_created_at TIMESTAMPTZ NOT NULL,
  processed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (octet_length(event_type) BETWEEN 1 AND 150)
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_processed
  ON stripe_webhook_event(processed_at DESC);

CREATE TABLE IF NOT EXISTS billing_invoice (
  stripe_invoice_id      TEXT        PRIMARY KEY CHECK (stripe_invoice_id ~ '^in_[A-Za-z0-9]+$'),
  user_id                UUID        REFERENCES user_account(user_id) ON DELETE SET NULL,
  stripe_customer_id     TEXT        NOT NULL CHECK (stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  stripe_subscription_id TEXT        CHECK (stripe_subscription_id IS NULL OR stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  status                 TEXT,
  currency               CHAR(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_due             BIGINT      NOT NULL CHECK (amount_due >= 0),
  amount_paid            BIGINT      NOT NULL CHECK (amount_paid >= 0),
  amount_remaining       BIGINT      NOT NULL CHECK (amount_remaining >= 0),
  period_starts_at       TIMESTAMPTZ NOT NULL,
  period_ends_at         TIMESTAMPTZ NOT NULL,
  paid_at                TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_invoice_user_created
  ON billing_invoice(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_type_check;
ALTER TABLE notification ADD CONSTRAINT notification_type_check
  CHECK (type IN ('new_match', 'new_message', 'profile_liked', 'match_expiring', 'billing_payment_failed', 'subscription_trial_ending'));

CREATE OR REPLACE FUNCTION fct_cleanup_billing_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE billing_invoice SET user_id = NULL WHERE user_id = NEW.user_id;
  DELETE FROM billing_checkout_session WHERE user_id = NEW.user_id;
  DELETE FROM billing_customer WHERE user_id = NEW.user_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cleanup_billing_identity ON user_account;
CREATE TRIGGER trg_cleanup_billing_identity
AFTER UPDATE OF anonymized_at ON user_account
FOR EACH ROW
WHEN (OLD.anonymized_at IS DISTINCT FROM NEW.anonymized_at AND NEW.anonymized_at IS NOT NULL)
EXECUTE FUNCTION fct_cleanup_billing_identity();
