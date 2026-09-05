-- Reconciliation Stripe durable et protection optimiste des projections.

ALTER TABLE user_subscription
  ADD COLUMN projection_version bigint DEFAULT 0 NOT NULL,
  ADD COLUMN provider_snapshot_at timestamp with time zone,
  ADD CONSTRAINT user_subscription_projection_version_check CHECK (projection_version >= 0);

ALTER TABLE billing_customer
  ADD COLUMN stripe_reconciliation_due_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  ADD COLUMN stripe_reconciled_at timestamp with time zone,
  ADD CONSTRAINT billing_customer_reconciliation_order_check CHECK (
    stripe_reconciled_at IS NULL OR stripe_reconciliation_due_at >= stripe_reconciled_at
  );

ALTER TABLE billing_checkout_session
  ADD CONSTRAINT billing_checkout_created_customer_id_check CHECK (
    created_customer_id IS NULL OR created_customer_id ~ '^cus_[A-Za-z0-9]+$'
  );

CREATE INDEX idx_billing_customer_reconciliation_due
  ON billing_customer (stripe_reconciliation_due_at, user_id)
  WHERE stripe_customer_deleted_at IS NULL;

ALTER TABLE maintenance_job_status
  DROP CONSTRAINT maintenance_job_status_job_name_check,
  ADD CONSTRAINT maintenance_job_status_job_name_check CHECK (
    job_name = ANY (ARRAY['matches', 'photos', 'privacy', 'outbox', 'billing']::text[])
  );

-- Les créations déjà incertaines sont reprises sans refaire leur POST. Le worker
-- interroge Stripe par fenêtre de création et métadonnées avant toute décision.
INSERT INTO outbox_event (id, event_type, aggregate_id, available_at)
SELECT uuid_generate_v4(), 'billing.customer.reconcile', checkout.id,
  GREATEST(clock_timestamp(), checkout.customer_creation_started_at + interval '23 hours')
FROM billing_checkout_session AS checkout
WHERE checkout.customer_creation_started_at IS NOT NULL
  AND checkout.created_customer_id IS NULL
  AND checkout.customer_erased_at IS NULL
ON CONFLICT (event_type, aggregate_id) DO NOTHING;
