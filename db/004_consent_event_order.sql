-- Preserve the exact database insertion order of legal-choice events. UUIDs
-- and timestamps are not reliable tie-breakers for concurrent writes.

ALTER TABLE user_consent
  ADD COLUMN IF NOT EXISTS event_sequence BIGSERIAL;

-- Reconstruct a deterministic chronological order for existing proofs.
WITH ordered_events AS (
  SELECT id, ROW_NUMBER() OVER (
    ORDER BY user_id, consent_type,
      CASE
        WHEN granted = true AND withdrawn_at IS NULL THEN 2
        WHEN granted = false THEN 1
        ELSE 0
      END,
      granted_at,
      id
  ) AS sequence
  FROM user_consent
)
UPDATE user_consent AS consent
SET event_sequence = ordered_events.sequence
FROM ordered_events
WHERE consent.id = ordered_events.id;

SELECT setval(
  pg_get_serial_sequence('user_consent', 'event_sequence'),
  COALESCE((SELECT MAX(event_sequence) FROM user_consent), 1),
  EXISTS (SELECT 1 FROM user_consent)
);

ALTER TABLE user_consent
  ALTER COLUMN event_sequence SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_consent_event_sequence
  ON user_consent(event_sequence);
