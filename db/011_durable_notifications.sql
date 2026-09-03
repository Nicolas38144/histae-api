-- Existing notifications are intentionally not replayed during deployment.
ALTER TABLE notification ADD COLUMN deduplication_key TEXT UNIQUE
  CHECK (deduplication_key IS NULL OR deduplication_key ~ '^[0-9a-f]{64}$');

-- One independently retryable outbox event per device present at scheduling time.
-- No copied FCM token or private message text. Revocation/erasure cancels delivery.
CREATE TABLE notification_push_delivery (
  id UUID PRIMARY KEY REFERENCES outbox_event(id) ON DELETE CASCADE,
  notification_id UUID NOT NULL REFERENCES notification(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES device_token(id) ON DELETE CASCADE,
  session_id UUID,
  UNIQUE (notification_id, device_id)
);
CREATE INDEX idx_notification_push_device ON notification_push_delivery(device_id);

COMMENT ON TABLE notification_push_delivery IS
  'Pending or completed per-device delivery references; expires with the notification, device, or resolved outbox event. No provider token is copied.';
