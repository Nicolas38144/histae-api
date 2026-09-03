-- Moderation state is deliberately separated from the technical photo lifecycle.
-- A stored object may be ready while remaining invisible until moderation approves it.

ALTER TABLE data_access_log
  DROP CONSTRAINT data_access_log_action_check;

ALTER TABLE data_access_log
  ADD CONSTRAINT data_access_log_action_check CHECK (action IN (
    'view_profile',
    'view_messages',
    'view_matches',
    'export_data',
    'admin_ban',
    'admin_unban',
    'admin_review_report',
    'admin_review_dsr',
    'admin_reconcile_photo',
    'view_moderation_content',
    'admin_review_content',
    'system_anonymize',
    'system_export_portability'
  ));

CREATE TABLE content_moderation_case (
  id                       UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                  UUID        NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  content_type             TEXT        NOT NULL CHECK (content_type IN ('photo', 'bio', 'profile_answer')),
  photo_id                 UUID        REFERENCES user_photo(id) ON DELETE CASCADE,
  bio_user_id              UUID        REFERENCES user_profile(user_id) ON DELETE CASCADE,
  profile_answer_id        UUID        REFERENCES user_profile_answer(id) ON DELETE CASCADE,
  status                   TEXT        NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  reason_codes             TEXT[]      NOT NULL DEFAULT ARRAY[]::text[],
  policy_version           TEXT        NOT NULL,
  version                  INTEGER     NOT NULL DEFAULT 1 CHECK (version > 0),
  face_count               SMALLINT    CHECK (face_count BETWEEN 0 AND 100),
  sharpness_score          DOUBLE PRECISION CHECK (sharpness_score >= 0 AND sharpness_score < 1000000000000),
  nsfw_score               DOUBLE PRECISION CHECK (nsfw_score BETWEEN 0 AND 1),
  face_detectable          BOOLEAN,
  sharp_enough             BOOLEAN,
  content_allowed          BOOLEAN,
  reviewed_by              UUID        REFERENCES user_account(user_id) ON DELETE SET NULL,
  reviewed_at              TIMESTAMPTZ,
  review_reason            TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chk_content_moderation_source CHECK (
    (content_type = 'photo' AND photo_id IS NOT NULL AND bio_user_id IS NULL AND profile_answer_id IS NULL)
    OR (content_type = 'bio' AND photo_id IS NULL AND bio_user_id IS NOT NULL AND profile_answer_id IS NULL)
    OR (content_type = 'profile_answer' AND photo_id IS NULL AND bio_user_id IS NULL AND profile_answer_id IS NOT NULL)
  ),
  CONSTRAINT chk_content_moderation_reason_codes CHECK (
    reason_codes <@ ARRAY[
      'spam', 'insult', 'personal_contact', 'sexual_content',
      'face_not_detected', 'multiple_faces', 'blurry', 'explicit_image',
      'analysis_unavailable', 'legacy_unreviewed'
    ]::text[]
  ),
  CONSTRAINT chk_content_moderation_policy_version CHECK (
    policy_version ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'
  ),
  CONSTRAINT chk_content_moderation_review_reason CHECK (
    review_reason IS NULL OR (
      review_reason = btrim(review_reason)
      AND char_length(review_reason) BETWEEN 3 AND 500
      AND octet_length(review_reason) <= 1000
    )
  ),
  CONSTRAINT chk_content_moderation_photo_checks CHECK (
    content_type = 'photo'
    OR (face_count IS NULL AND sharpness_score IS NULL AND nsfw_score IS NULL
      AND face_detectable IS NULL AND sharp_enough IS NULL AND content_allowed IS NULL)
  )
);

CREATE UNIQUE INDEX uq_content_moderation_photo
  ON content_moderation_case(photo_id) WHERE photo_id IS NOT NULL;
CREATE UNIQUE INDEX uq_content_moderation_bio
  ON content_moderation_case(bio_user_id) WHERE bio_user_id IS NOT NULL;
CREATE UNIQUE INDEX uq_content_moderation_profile_answer
  ON content_moderation_case(profile_answer_id) WHERE profile_answer_id IS NOT NULL;
CREATE INDEX idx_content_moderation_queue
  ON content_moderation_case(status, updated_at DESC, id DESC);
CREATE INDEX idx_content_moderation_user
  ON content_moderation_case(user_id, updated_at DESC);

-- Existing public content has never passed the new policy. Keep it private until
-- an administrator reviews it instead of implicitly grandfathering it in.
INSERT INTO content_moderation_case (
  user_id, content_type, bio_user_id, status, reason_codes, policy_version
)
SELECT user_id, 'bio', user_id, 'pending', ARRAY['legacy_unreviewed'], 'legacy_import_v1'
FROM user_profile
WHERE bio IS NOT NULL AND btrim(bio) <> '';

INSERT INTO content_moderation_case (
  user_id, content_type, profile_answer_id, status, reason_codes, policy_version
)
SELECT user_id, 'profile_answer', id, 'pending', ARRAY['legacy_unreviewed'], 'legacy_import_v1'
FROM user_profile_answer;

INSERT INTO content_moderation_case (
  user_id, content_type, photo_id, status, reason_codes, policy_version
)
SELECT user_id, 'photo', id, 'pending', ARRAY['legacy_unreviewed'], 'legacy_import_v1'
FROM user_photo
WHERE status = 'ready';

COMMENT ON TABLE content_moderation_case IS
  'Current moderation decision for one active photo, bio, or profile answer. Source content remains in its domain table.';
COMMENT ON COLUMN content_moderation_case.reason_codes IS
  'Closed, non-sensitive signal codes only; never provider output or user content.';
