-- Private profile-photo lifecycle.
-- The previous provisional implementation stored a deterministic object key
-- directly on user_profile. It was never committed as a production contract,
-- so refuse to discard any non-null value whose technical metadata is unknown.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM user_profile WHERE photo IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot migrate non-null user_profile.photo values without verified object metadata';
  END IF;
END
$$;

CREATE TABLE user_photo (
  id          UUID        PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES user_profile(user_id) ON DELETE CASCADE,
  object_key  TEXT        UNIQUE NOT NULL,
  status      TEXT        NOT NULL CHECK (status IN ('pending', 'processing', 'ready', 'deleting')),
  mime_type   TEXT,
  size_bytes  INTEGER,
  width       INTEGER,
  height      INTEGER,
  sha256      BYTEA,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_user_photo_object_key CHECK (
    object_key = 'profile-photos/' || user_id::text || '/' || id::text || '.webp'
  ),
  CONSTRAINT chk_user_photo_mime_type CHECK (mime_type IS NULL OR mime_type = 'image/webp'),
  CONSTRAINT chk_user_photo_size CHECK (size_bytes IS NULL OR size_bytes BETWEEN 1 AND 500000),
  CONSTRAINT chk_user_photo_width CHECK (width IS NULL OR width BETWEEN 1 AND 2048),
  CONSTRAINT chk_user_photo_height CHECK (height IS NULL OR height BETWEEN 1 AND 2048),
  CONSTRAINT chk_user_photo_sha256 CHECK (sha256 IS NULL OR octet_length(sha256) = 32),
  CONSTRAINT chk_user_photo_metadata_completeness CHECK (
    (mime_type IS NULL AND size_bytes IS NULL AND width IS NULL AND height IS NULL AND sha256 IS NULL)
    OR
    (mime_type IS NOT NULL AND size_bytes IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL AND sha256 IS NOT NULL)
  ),
  CONSTRAINT chk_user_photo_ready_metadata CHECK (
    status <> 'ready'
    OR (mime_type IS NOT NULL AND size_bytes IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL AND sha256 IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_user_photo_ready
  ON user_photo(user_id) WHERE status = 'ready';

CREATE UNIQUE INDEX uq_user_photo_in_progress
  ON user_photo(user_id) WHERE status IN ('pending', 'processing');

CREATE INDEX idx_user_photo_cleanup
  ON user_photo(status, updated_at, id) WHERE status IN ('pending', 'processing', 'deleting');

COMMENT ON TABLE user_photo IS 'Private, versioned profile-photo objects and their recoverable cross-storage lifecycle.';
COMMENT ON COLUMN user_photo.object_key IS 'Provider-neutral private S3 key; never a public or signed URL.';
COMMENT ON COLUMN user_photo.sha256 IS 'SHA-256 digest of the normalized WebP bytes.';

ALTER TABLE user_profile DROP CONSTRAINT chk_user_profile_photo_object_key;
ALTER TABLE user_profile DROP COLUMN photo;
