-- Separate contractual acceptance, privacy notice acknowledgement and actual
-- consent purposes. Histae does not perform marketing processing.

ALTER TABLE user_consent
  DROP CONSTRAINT IF EXISTS user_consent_consent_type_check;

-- No marketing processing exists in Histae, so these obsolete choices no
-- longer have a purpose in the application model.
DELETE FROM user_consent WHERE consent_type = 'marketing';

UPDATE user_consent SET consent_type = CASE consent_type
  WHEN 'terms_of_service' THEN 'terms_of_service_acceptance'
  WHEN 'privacy_policy' THEN 'privacy_notice_acknowledgement'
  WHEN 'sensitive_data_processing' THEN 'sensitive_data_consent'
  WHEN 'location_processing' THEN 'location_consent'
  ELSE consent_type
END
WHERE consent_type IN (
  'terms_of_service',
  'privacy_policy',
  'sensitive_data_processing',
  'location_processing'
);

-- Unversioned legacy proofs cannot satisfy the current application version,
-- but remain identifiable for the retention period.
UPDATE user_consent
SET document_version = 'legacy-unversioned'
WHERE document_version IS NULL;

ALTER TABLE user_consent
  ALTER COLUMN document_version SET NOT NULL;

ALTER TABLE user_consent
  ADD CONSTRAINT user_consent_consent_type_check CHECK (consent_type IN (
    'terms_of_service_acceptance',
    'privacy_notice_acknowledgement',
    'sensitive_data_consent',
    'location_consent'
  ));

-- Keep only the most recent active proof if legacy concurrent writes created
-- duplicates, then enforce the invariant at database level.
WITH ranked_active AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY user_id, consent_type
    ORDER BY granted_at DESC, id DESC
  ) AS position
  FROM user_consent
  WHERE granted = true AND withdrawn_at IS NULL
)
UPDATE user_consent AS consent
SET withdrawn_at = clock_timestamp()
FROM ranked_active
WHERE consent.id = ranked_active.id AND ranked_active.position > 1;

DROP INDEX IF EXISTS idx_consent_active;
CREATE UNIQUE INDEX idx_consent_active ON user_consent(user_id, consent_type)
  WHERE withdrawn_at IS NULL AND granted = true;
