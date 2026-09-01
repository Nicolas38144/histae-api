-- =========================================
-- EXTENSIONS
-- =========================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- =========================================
-- USER ACCOUNT (AUTH / SECURITY)
-- RGPD :
--   - phone_number_encrypted : AES-256-GCM applicatif avec nonce et tag d'authentification
--   - phone_number_hash      : HMAC-SHA-256 applicatif pour lookup/unicité sans stocker le clair
--   - deleted_at             : soft delete RGPD (Art. 17 — droit à l'effacement)
--   - anonymized_at          : date d'anonymisation effective
-- Durée de conservation : comptes actifs indéfiniment ; données anonymisées 30 jours après suppression
-- =========================================
CREATE TABLE user_account (
  user_id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  role                  TEXT        NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin', 'superadmin')),
  phone_number_hash      TEXT        UNIQUE NOT NULL,           -- HMAC-SHA-256 applicatif du numéro
  phone_number_encrypted BYTEA      NOT NULL,                  -- AES-256-GCM applicatif, jamais en clair
  is_banned             BOOLEAN     NOT NULL DEFAULT false,
  banned_at             TIMESTAMPTZ,
  banned_reason         TEXT,
  banned_by             UUID        REFERENCES user_account(user_id) ON DELETE SET NULL,
  deleted_at            TIMESTAMPTZ,                           -- NULL = compte actif
  anonymized_at         TIMESTAMPTZ,                           -- NULL = données non encore anonymisées
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A tombstone is retained only for previously banned accounts, so an erasure
-- cannot be used to immediately bypass a safety ban. Normal deletions create
-- no tombstone.
CREATE TABLE account_tombstone (
  phone_number_hash TEXT PRIMARY KEY,
  reason            TEXT        NOT NULL CHECK (reason IN ('banned_account')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_tombstone_expiry ON account_tombstone(expires_at);


-- =========================================
-- SUBSCRIPTION PLAN CATALOG
-- Prices are stored in minor currency units so the application never uses
-- floating point amounts. The seeded Premium prices are initial commercial
-- defaults and can be changed without a code deployment.
-- =========================================
CREATE TABLE subscription_plan (
  code                       TEXT        PRIMARY KEY,
  display_name               TEXT        NOT NULL,
  monthly_price_cents        INTEGER     NOT NULL CHECK (monthly_price_cents >= 0),
  annual_price_cents         INTEGER     NOT NULL CHECK (annual_price_cents >= 0),
  currency                   CHAR(3)     NOT NULL DEFAULT 'EUR' CHECK (currency ~ '^[A-Z]{3}$'),
  weekly_continuation_limit  SMALLINT    CHECK (weekly_continuation_limit IS NULL OR weekly_continuation_limit >= 0),
  trial_days                 SMALLINT    NOT NULL DEFAULT 0 CHECK (trial_days >= 0),
  is_active                  BOOLEAN     NOT NULL DEFAULT true,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (annual_price_cents <= monthly_price_cents * 12)
);

-- =========================================
-- SUBSCRIPTION PLAN FEATURES
-- This normalized catalog drives the paywall and pricing screens. Feature
-- values are JSON to allow a number, boolean, text, or future structured rule.
-- =========================================
CREATE TABLE subscription_plan_feature (
  plan_code    TEXT        NOT NULL REFERENCES subscription_plan(code) ON DELETE CASCADE,
  feature_code TEXT        NOT NULL,
  display_name TEXT        NOT NULL,
  description  TEXT        NOT NULL,
  feature_value JSONB      NOT NULL DEFAULT '{}'::jsonb,
  sort_order   SMALLINT    NOT NULL DEFAULT 0,
  PRIMARY KEY (plan_code, feature_code)
);

-- =========================================
-- USER SUBSCRIPTION / ENTITLEMENT
-- Stores the plan granted by a verified billing provider. A missing row is
-- equivalent to the free plan. The mobile client must never write this table
-- directly; verified Stripe webhooks own premium activation and renewal.
-- =========================================
CREATE TABLE user_subscription (
  user_id                UUID        PRIMARY KEY REFERENCES user_account(user_id) ON DELETE CASCADE,
  plan                   TEXT        NOT NULL DEFAULT 'free' REFERENCES subscription_plan(code),
  provider               TEXT        CHECK (provider IS NULL OR provider = 'stripe'),
  provider_subscription_id TEXT      UNIQUE CHECK (provider_subscription_id IS NULL OR provider_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  provider_price_id      TEXT        CHECK (provider_price_id IS NULL OR provider_price_id ~ '^price_[A-Za-z0-9]+$'),
  billing_period         TEXT        CHECK (billing_period IS NULL OR billing_period IN ('monthly', 'annual')),
  status                 TEXT        CHECK (status IS NULL OR status IN ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  cancel_at_period_end   BOOLEAN     NOT NULL DEFAULT false,
  current_period_starts_at TIMESTAMPTZ,
  current_period_ends_at TIMESTAMPTZ,
  trial_ends_at          TIMESTAMPTZ,
  canceled_at            TIMESTAMPTZ,
  provider_event_created_at TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE billing_customer (
  user_id            UUID        PRIMARY KEY REFERENCES user_account(user_id) ON DELETE CASCADE,
  stripe_customer_id TEXT        NOT NULL UNIQUE CHECK (stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  stripe_customer_deleted_at TIMESTAMPTZ,
  trial_used_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE billing_checkout_session (
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
CREATE INDEX idx_billing_customer_active_stripe_id ON billing_customer(stripe_customer_id) WHERE stripe_customer_deleted_at IS NULL;
CREATE UNIQUE INDEX idx_billing_checkout_one_live_per_user ON billing_checkout_session(user_id) WHERE status IN ('creating', 'open');
CREATE INDEX idx_billing_checkout_expiry ON billing_checkout_session(expires_at) WHERE status IN ('creating', 'open');

CREATE TABLE stripe_webhook_event (
  id                TEXT        PRIMARY KEY CHECK (id ~ '^evt_[A-Za-z0-9]+$'),
  event_type        TEXT        NOT NULL,
  object_id         TEXT,
  livemode          BOOLEAN     NOT NULL,
  api_version       TEXT,
  stripe_created_at TIMESTAMPTZ NOT NULL,
  processed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (octet_length(event_type) BETWEEN 1 AND 150)
);
CREATE INDEX idx_stripe_webhook_processed ON stripe_webhook_event(processed_at DESC);

CREATE TABLE billing_invoice (
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
  provider_event_created_at TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_billing_invoice_user_created ON billing_invoice(user_id, created_at DESC) WHERE user_id IS NOT NULL;

-- USER LEGAL CHOICES (RGPD Art. 6, 7, 9)
-- Trace séparément acceptation contractuelle, accusé de lecture et consentements.
-- Histae ne réalise aucun traitement marketing.
--   - terms_of_service_acceptance       : acceptation contractuelle à l'inscription
--   - privacy_notice_acknowledgement    : preuve de présentation de l'information RGPD
--   - sensitive_data_consent            : consentement explicite avant sex / looking_for (Art. 9)
--   - location_consent                  : consentement avant d'activer la géolocalisation
-- Durée de conservation : 5 ans après retrait du consentement (preuve légale)
-- =========================================
CREATE TABLE user_consent (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_sequence BIGSERIAL NOT NULL,
  user_id      UUID        NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  consent_type TEXT        NOT NULL CHECK (consent_type IN (
    'terms_of_service_acceptance',
    'privacy_notice_acknowledgement',
    'sensitive_data_consent',      -- Art. 9 : orientation sexuelle (sex, looking_for)
    'location_consent'
  )),
  granted      BOOLEAN     NOT NULL,                           -- true = accordé, false = retiré
  document_version TEXT        NOT NULL,
  ip_address   TEXT,                                          -- preuve du consentement
  user_agent   TEXT,
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at TIMESTAMPTZ                                    -- NULL = toujours actif
);

CREATE INDEX IF NOT EXISTS idx_consent_type      ON user_consent(user_id, consent_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_consent_event_sequence ON user_consent(event_sequence);
CREATE UNIQUE INDEX IF NOT EXISTS idx_consent_active ON user_consent(user_id, consent_type)
  WHERE withdrawn_at IS NULL AND granted = true;


-- =========================================
-- DATA SUBJECT REQUEST — RGPD Art. 15 à 22
-- Gestion des demandes d'exercice des droits :
--   - access       : droit d'accès (Art. 15)
--   - erasure      : droit à l'effacement (Art. 17)
--   - portability  : droit à la portabilité (Art. 20)
--   - rectification: droit de rectification (Art. 16)
--   - restriction  : droit à la limitation du traitement (Art. 18)
--   - objection    : droit d'opposition (Art. 21)
-- Délai légal de traitement : 1 mois (Art. 12)
-- Durée de conservation : 5 ans (preuve de conformité)
-- =========================================
CREATE TABLE data_subject_request (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID        NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  type         TEXT        NOT NULL CHECK (type IN (
    'access',
    'erasure',
    'portability',
    'rectification',
    'restriction',
    'objection'
  )),
  status       TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',
    'in_progress',
    'completed',
    'rejected'
  )),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  handled_by   UUID REFERENCES user_account(user_id) ON DELETE SET NULL,  -- admin traitant
  notes        TEXT
);

CREATE INDEX IF NOT EXISTS idx_dsr_user     ON data_subject_request(user_id);
CREATE INDEX IF NOT EXISTS idx_dsr_status   ON data_subject_request(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dsr_one_open_per_type ON data_subject_request(user_id, type)
  WHERE status IN ('pending', 'in_progress');


-- =========================================
-- DATA ACCESS LOG — RGPD Art. 5 (Traçabilité)
-- Journalise tout accès admin/système aux données personnelles.
-- Obligatoire pour démontrer la conformité (accountability, Art. 5 §2).
-- Durée de conservation : 3 ans
-- =========================================
CREATE TABLE data_access_log (
  id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  accessed_user_id UUID        NOT NULL,                       -- utilisateur dont les données ont été accédées
  accessor_id      UUID        REFERENCES user_account(user_id) ON DELETE SET NULL, -- NULL = système automatique
  accessor_role    TEXT,
  action           TEXT        NOT NULL CHECK (action IN (
    'view_profile',
    'view_messages',
    'view_matches',
    'export_data',
    'admin_ban',
    'admin_unban',
    'admin_review_report',
    'admin_review_dsr',
    'system_anonymize',
    'system_export_portability'
  )),
  reason           TEXT,                                       -- justification de l'accès
  accessed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dal_accessed_user ON data_access_log(accessed_user_id);
CREATE INDEX IF NOT EXISTS idx_dal_accessor      ON data_access_log(accessor_id);
CREATE INDEX IF NOT EXISTS idx_dal_date          ON data_access_log(accessed_at DESC);


-- =========================================
-- OTP VERIFICATION (VÉRIFICATION TÉLÉPHONE)
-- Durée de conservation : auto-purge des OTP expirés via job planifié
-- =========================================
CREATE TABLE otp_verification (
  id                      UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone_number_hash       TEXT        NOT NULL,
  otp_hash                TEXT        NOT NULL,                -- HMAC-SHA-256 applicatif de l'OTP, jamais en clair
  expires_at              TIMESTAMPTZ NOT NULL,
  used                    BOOLEAN     NOT NULL DEFAULT false,
  idempotency_key         UUID        NOT NULL DEFAULT uuid_generate_v4(),
  delivery_status         TEXT        NOT NULL DEFAULT 'pending'
    CONSTRAINT chk_otp_delivery_status CHECK (delivery_status IN ('pending', 'sent', 'failed')),
  provider                TEXT        NOT NULL DEFAULT 'sweego',
  provider_transaction_id TEXT,
  provider_message_id     TEXT,
  delivery_error_code     TEXT,
  sent_at                 TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otp_phone       ON otp_verification(phone_number_hash);
CREATE INDEX IF NOT EXISTS idx_otp_expires     ON otp_verification(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_otp_idempotency ON otp_verification(idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_otp_one_usable_per_phone ON otp_verification(phone_number_hash)
  WHERE delivery_status = 'sent' AND used = false;


-- =========================================
-- USER PROFILE (PUBLIC)
-- RGPD Art. 9 :
--   sex est une donnée à caractère sensible.
--   Elles ne peuvent être renseignées qu'après consentement explicite enregistré
--   dans user_consent (consent_type = 'sensitive_data_consent').
--   → Ces colonnes sont nullable : NULL = consentement non donné ou retiré.
-- Durée de conservation : supprimée à l'anonymisation du compte
-- =========================================
CREATE TABLE user_profile (
  user_id     UUID  PRIMARY KEY REFERENCES user_account(user_id) ON DELETE CASCADE,
  firstname   TEXT  NOT NULL,
  birthdate   DATE  NOT NULL,
  sex         TEXT  CHECK (sex IN ('male', 'female', 'other')),         -- Art. 9 — requiert consentement
  bio         TEXT,
  photo       TEXT,
  CONSTRAINT chk_user_profile_photo_object_key CHECK (
    photo IS NULL OR photo ~ '^profile-photos/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/photo[.]webp$'
  )
);

COMMENT ON COLUMN user_profile.photo IS 'Private S3 object key for the normalized WebP profile photo; never a public URL.';


-- =========================================
-- USER PREFERENCES (FILTRES DE RECHERCHE)
-- Durée de conservation : supprimée avec le compte
-- =========================================
CREATE TABLE user_preferences (
  user_id         UUID  PRIMARY KEY REFERENCES user_account(user_id) ON DELETE CASCADE,
  min_age         INT   NOT NULL DEFAULT 18,
  max_age         INT   NOT NULL DEFAULT 99,
  max_distance_km INT   NOT NULL DEFAULT 50,
  looking_for     TEXT  NOT NULL DEFAULT 'male' CHECK (looking_for IN ('male', 'female', 'both', 'other')),
  CONSTRAINT chk_age_range CHECK (min_age >= 18 AND max_age >= min_age AND max_age <= 99),
  CONSTRAINT chk_distance  CHECK (max_distance_km > 0)
);


-- =========================================
-- USER PRESENCE (GÉOLOCALISATION)
-- RGPD :
--   - La localisation est une donnée personnelle sensible.
--   - Elle ne peut être collectée qu'avec le consentement explicite de l'utilisateur
--     (user_consent.consent_type = 'location_consent').
--   - Précision réduite à ~11m (NUMERIC 9,6) au lieu de la précision GPS complète.
--   - is_location_fresh passe à false automatiquement après 1h d'inactivité (via job).
--   - La localisation est effacée lors de l'anonymisation du compte.
-- Durée de conservation : 1h active, puis marquée stale ; effacée à la suppression
-- =========================================
CREATE TABLE user_presence (
  user_id           UUID           PRIMARY KEY REFERENCES user_account(user_id) ON DELETE CASCADE,
  latitude          NUMERIC(9, 6),                             -- ~11m de précision
  longitude         NUMERIC(9, 6),
  is_location_fresh BOOLEAN        NOT NULL DEFAULT false,     -- false = localisation obsolète
  updated_at        TIMESTAMPTZ    NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_presence_location ON user_presence(latitude, longitude)
  WHERE is_location_fresh = true;


-- =========================================
-- TRAITS (PERSONNALITÉ)
-- =========================================
CREATE TABLE trait (
  id   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE user_trait (
  user_id  UUID REFERENCES user_account(user_id) ON DELETE CASCADE,
  trait_id UUID REFERENCES trait(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, trait_id)
);


-- =========================================
-- MATCHES
-- Cycle de vie :
--   1. Création  → status = 'active', expires_at = created_at + 24h
--   2. Job horaire : expires_at < now() ET les deux users n'ont pas continued = true
--                  → status = 'expired', purge_after = now() + 30 jours
--   3. Job nightly : status = 'expired' ET purge_after < now()
--                  → hard delete (RGPD — purge définitive)
--   4. Si les deux users confirment continued = true avant expires_at
--                  → status = 'active' (match confirmé, pas d'expiration)
-- Durée de conservation : actifs indéfiniment ; expirés 30 jours puis supprimés
-- =========================================
-- IMPORTANT: the current lifecycle supersedes the legacy notes above.
-- active lasts for the first 24 hours. It then becomes
-- awaiting_continuation for a new, full 24-hour mutual-decision window.
-- Mutual continuation changes the status to confirmed; otherwise it becomes
-- expired and is purged 30 days later. Photo reveal is independent from this
-- lifecycle and becomes effective only after both participant consents.
CREATE TABLE match_init (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user1_id        UUID        NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  user2_id        UUID        NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  status          TEXT        NOT NULL DEFAULT 'active' CHECK (status IN (
	'awaiting_continuation', -- second 24-hour decision window
    'active',   -- match en cours, fenêtre de 24h ouverte
    'confirmed',-- les deux users ont décidé de continuer
    'expired',  -- fenêtre 24h dépassée sans décision mutuelle (soft delete)
    'ended'     -- match terminé volontairement par un des users
  )),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours'), -- toujours 24h par défaut
  purge_after     TIMESTAMPTZ,                                 -- renseigné lors du passage à 'expired'
  continuation_initiator_id UUID REFERENCES user_account(user_id) ON DELETE SET NULL, -- charged only after mutual continuation
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ,
  CHECK (user1_id < user2_id),
  UNIQUE (user1_id, user2_id)
);

CREATE TABLE match_state (
  match_id  UUID    NOT NULL REFERENCES match_init(id) ON DELETE CASCADE,
  user_id   UUID    NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  revealed  BOOLEAN NOT NULL DEFAULT false,
  continued BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (match_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_match_init_user1        ON match_init(user1_id);
CREATE INDEX IF NOT EXISTS idx_match_init_user2        ON match_init(user2_id);
CREATE INDEX IF NOT EXISTS idx_match_init_activity     ON match_init ((COALESCE(last_message_at, created_at)) DESC, id DESC);
-- Index pour le job horaire d'expiration
CREATE INDEX IF NOT EXISTS idx_match_init_to_expire    ON match_init(expires_at)
  WHERE status IN ('active', 'awaiting_continuation');
-- Index pour le job nightly de purge définitive
CREATE INDEX IF NOT EXISTS idx_match_init_to_purge     ON match_init(purge_after)
  WHERE status IN ('expired', 'ended');
CREATE INDEX IF NOT EXISTS idx_match_state_user        ON match_state(user_id);

-- =========================================
-- CONTINUATION USAGE (FREEMIUM)
-- Counts successful continuations initiated by a free user. The first request
-- does not consume a credit; the counter increments atomically only when the
-- other participant accepts. The counter resets each Monday in UTC.
-- =========================================
CREATE TABLE continuation_usage (
  user_id    UUID NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  used_count SMALLINT NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  PRIMARY KEY (user_id, week_start)
);


-- =========================================
-- MESSAGES
-- Règle métier : les messages sont IMMUABLES côté utilisateur.
--   Ni modification, ni suppression ne sont autorisées par l'API.
--   read_at est le seul champ mis à jour (accusé de réception, pas du contenu).
--
-- RGPD — exception légale système (Art. 17) :
--   En cas de demande d'effacement, la fonction anonymize_user() écrase
--   le contenu avec "[Message supprimé]". Cette opération est réservée
--   au système et n'est jamais exposée dans l'API utilisateur.
-- Durée de conservation : durée de vie du match (actifs), 30 jours (expirés)
-- =========================================
CREATE TABLE chat_message (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  match_id   UUID        NOT NULL REFERENCES match_init(id) ON DELETE CASCADE,
  sender_id  UUID        NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  idempotency_key UUID,
  content    TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at    TIMESTAMPTZ                                       -- NULL = non lu ; jamais modifié par l'expéditeur
);

CREATE INDEX IF NOT EXISTS idx_message_match_created_desc ON chat_message(match_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_message_sender_idempotency
  ON chat_message(sender_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_message_match_unread
  ON chat_message(match_id, created_at DESC, id DESC) WHERE read_at IS NULL;


-- =========================================
-- REFRESH TOKENS (AUTH / SECURITY)
-- Durée de conservation : supprimés automatiquement à l'expiration via job planifié
-- =========================================
CREATE TABLE refresh_tokens (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID        NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  token_hash TEXT        NOT NULL,
  jti        UUID        NOT NULL UNIQUE,
  revoked    BOOLEAN     NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user   ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);


-- =========================================
-- USER BLOCK
-- =========================================
CREATE TABLE user_block (
  blocker_id UUID        NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  blocked_id UUID        NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_user_block_blocked ON user_block(blocked_id);


-- =========================================
-- USER REPORT (SIGNALEMENT)
-- Durée de conservation : 3 ans après résolution (obligation légale potentielle)
-- =========================================
CREATE TABLE user_report (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  reporter_id UUID        NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  reported_id UUID        NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  match_id    UUID        REFERENCES match_init(id) ON DELETE SET NULL,
  reason      TEXT        NOT NULL CHECK (reason IN (
    'inappropriate_content',
    'fake_profile',
    'harassment',
    'spam',
    'other'
  )),
  description TEXT,
  status      TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'dismissed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CHECK (reporter_id <> reported_id)
);

CREATE INDEX IF NOT EXISTS idx_user_report_reported ON user_report(reported_id);
CREATE INDEX IF NOT EXISTS idx_user_report_created_desc ON user_report(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_user_report_status_created_desc ON user_report(status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_user_report_resolved ON user_report(resolved_at)
  WHERE status IN ('reviewed', 'dismissed');
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_report_one_pending
  ON user_report(reporter_id, reported_id)
  WHERE status = 'pending';


-- =========================================
-- DEVICE TOKENS (PUSH NOTIFICATIONS)
-- Durée de conservation : supprimé à la révocation ou suppression du compte
-- =========================================
CREATE TABLE device_token (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID        NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  token        TEXT        NOT NULL UNIQUE,
  platform     TEXT        NOT NULL CHECK (platform IN ('ios', 'android')),
  app_version  TEXT        CHECK (app_version IS NULL OR octet_length(app_version) BETWEEN 1 AND 50),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_device_token_user ON device_token(user_id);


-- =========================================
-- ACCOUNT DELETION CONFIRMATION
-- Single-use, short-lived token. Only its SHA-256 hash is stored.
-- =========================================
CREATE TABLE account_deletion_token (
  id         UUID        PRIMARY KEY,
  user_id    UUID        NOT NULL UNIQUE REFERENCES user_account(user_id) ON DELETE CASCADE,
  token_hash TEXT        NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_account_deletion_token_expires ON account_deletion_token(expires_at);


-- =========================================
-- NOTIFICATION INBOX
-- Durée de conservation : 90 jours
-- =========================================
CREATE TABLE notification (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID        NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  type       TEXT        NOT NULL CHECK (type IN ('new_match', 'new_message', 'profile_liked', 'match_expiring', 'billing_payment_failed', 'subscription_trial_ending')),
  payload    JSONB,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '90 days')
);

CREATE INDEX IF NOT EXISTS idx_notification_user   ON notification(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_unread ON notification(user_id, read_at) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notification_expire ON notification(expires_at);

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

CREATE TRIGGER trg_cleanup_billing_identity
AFTER UPDATE OF anonymized_at ON user_account
FOR EACH ROW
WHEN (OLD.anonymized_at IS DISTINCT FROM NEW.anonymized_at AND NEW.anonymized_at IS NOT NULL)
EXECUTE FUNCTION fct_cleanup_billing_identity();


-- =========================================
-- FONCTION D'ANONYMISATION (RGPD Art. 17)
-- À appeler lors d'une demande de suppression ou après le délai de grâce.
-- Pseudonymise les données plutôt que de les détruire pour préserver
-- l'intégrité des conversations de l'autre utilisateur.
-- =========================================
CREATE OR REPLACE FUNCTION fct_anonymize_user(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO account_tombstone (phone_number_hash, reason, expires_at)
  SELECT phone_number_hash, 'banned_account', now() + INTERVAL '3 years'
  FROM user_account
  WHERE user_id = p_user_id AND is_banned = true
  ON CONFLICT (phone_number_hash) DO UPDATE
    SET expires_at = GREATEST(account_tombstone.expires_at, EXCLUDED.expires_at);

  INSERT INTO data_access_log (accessed_user_id, accessor_role, action, reason)
  VALUES (p_user_id, 'system', 'system_anonymize', 'Account erasure');

  UPDATE match_init
  SET status = 'ended', purge_after = COALESCE(purge_after, now() + INTERVAL '30 days')
  WHERE (user1_id = p_user_id OR user2_id = p_user_id)
    AND status IN ('active', 'awaiting_continuation', 'confirmed');

  UPDATE chat_message SET content = '[Message supprimé]'
  WHERE sender_id = p_user_id;

  DELETE FROM user_profile WHERE user_id = p_user_id;
  DELETE FROM user_preferences WHERE user_id = p_user_id;
  DELETE FROM user_trait WHERE user_id = p_user_id;
  DELETE FROM user_presence WHERE user_id = p_user_id;
  DELETE FROM refresh_tokens WHERE user_id = p_user_id;
  DELETE FROM device_token WHERE user_id = p_user_id;
  DELETE FROM notification WHERE user_id = p_user_id;
  DELETE FROM user_block WHERE blocker_id = p_user_id OR blocked_id = p_user_id;
  DELETE FROM user_subscription WHERE user_id = p_user_id;
  DELETE FROM continuation_usage WHERE user_id = p_user_id;
  DELETE FROM match_state WHERE user_id = p_user_id;

  UPDATE user_consent SET
    withdrawn_at = COALESCE(withdrawn_at, now()),
    ip_address = NULL,
    user_agent = NULL
  WHERE user_id = p_user_id;

  UPDATE user_account SET
    phone_number_hash = 'anon_' || encode(gen_random_bytes(16), 'hex'),
    phone_number_encrypted = '',
    is_banned = false,
    banned_at = NULL,
    banned_reason = NULL,
    banned_by = NULL,
    deleted_at = COALESCE(deleted_at, now()),
    anonymized_at = now()
  WHERE user_id = p_user_id;
END;
$$;


CREATE OR REPLACE FUNCTION fct_check_user_age()
RETURNS trigger AS $$
BEGIN
  IF NEW.birthdate > (CURRENT_DATE - INTERVAL '18 years')::date THEN
    RAISE EXCEPTION 'User must be at least 18 years old';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_enforce_user_age
BEFORE INSERT OR UPDATE ON user_profile
FOR EACH ROW
EXECUTE FUNCTION fct_check_user_age();
