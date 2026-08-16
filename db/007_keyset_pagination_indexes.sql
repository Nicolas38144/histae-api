-- Stable keyset pagination for high-volume match, message and moderation feeds.
CREATE INDEX IF NOT EXISTS idx_match_init_activity
  ON match_init ((COALESCE(last_message_at, created_at)) DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_message_match_created_desc
  ON chat_message (match_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_user_report_created_desc
  ON user_report (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_user_report_status_created_desc
  ON user_report (status, created_at DESC, id DESC);
