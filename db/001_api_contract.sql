-- Canonical PostgreSQL contract for Histae API.
-- This bootstrap is idempotent and never drops application data.
-- Unlike schema_postgres.sql, this file is the migration executed by db:migrate.

-- =========================================
-- EXTENSIONS
-- =========================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =========================================
-- USER ACCOUNT (AUTH / SECURITY)
-- RGPD : le numéro n'est jamais stocké en clair. Le hash sert à l'unicité
-- et au lookup ; le chiffré AES-256-GCM est réservé à l'application.
-- deleted_at / anonymized_at portent le cycle de suppression RGPD.
-- =========================================
CREATE TABLE IF NOT EXISTS user_account (
  user_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin', 'superadmin')),
  phone_number_hash TEXT UNIQUE NOT NULL,
  phone_number_encrypted BYTEA NOT NULL,
  is_banned BOOLEAN NOT NULL DEFAULT false,
  banned_at TIMESTAMPTZ,
  banned_reason TEXT,
  banned_by UUID REFERENCES user_account(user_id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ,
  anonymized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_account_phone_hash ON user_account(phone_number_hash);
CREATE INDEX IF NOT EXISTS idx_user_account_active ON user_account(deleted_at) WHERE deleted_at IS NULL;

-- =========================================
-- SUBSCRIPTION PLAN CATALOG
-- Les prix sont en centimes afin d'éviter tout calcul en virgule flottante.
-- Une ligne user_subscription absente équivaut au plan Free.
-- =========================================
CREATE TABLE IF NOT EXISTS subscription_plan (
  code TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  monthly_price_cents INTEGER NOT NULL CHECK (monthly_price_cents >= 0),
  annual_price_cents INTEGER NOT NULL CHECK (annual_price_cents >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'EUR' CHECK (currency ~ '^[A-Z]{3}$'),
  weekly_continuation_limit SMALLINT CHECK (weekly_continuation_limit IS NULL OR weekly_continuation_limit >= 0),
  trial_days SMALLINT NOT NULL DEFAULT 0 CHECK (trial_days >= 0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (annual_price_cents <= monthly_price_cents * 12)
);
CREATE TABLE IF NOT EXISTS subscription_plan_feature (
  plan_code TEXT NOT NULL REFERENCES subscription_plan(code) ON DELETE CASCADE,
  feature_code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL,
  feature_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (plan_code, feature_code)
);
CREATE TABLE IF NOT EXISTS user_subscription (
  user_id UUID PRIMARY KEY REFERENCES user_account(user_id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'free' REFERENCES subscription_plan(code),
  current_period_ends_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================================
-- OTP VERIFICATION (VÉRIFICATION TÉLÉPHONE)
-- Les OTP sont hashés ; expires_at les rend inutilisables par l'application.
-- =========================================
CREATE TABLE IF NOT EXISTS otp_verification (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone_number_hash TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_verification(phone_number_hash);
CREATE INDEX IF NOT EXISTS idx_otp_expires ON otp_verification(expires_at);

-- =========================================
-- USER PROFILE (PUBLIC)
-- sex est une donnée sensible : sa collecte requiert un consentement explicite.
-- Le trigger impose l'âge minimum de 18 ans.
-- =========================================
CREATE TABLE IF NOT EXISTS user_profile (
  user_id UUID PRIMARY KEY REFERENCES user_account(user_id) ON DELETE CASCADE,
  firstname TEXT NOT NULL,
  birthdate DATE NOT NULL,
  sex TEXT CHECK (sex IN ('male', 'female', 'other')),
  bio TEXT,
  photo TEXT
);
CREATE OR REPLACE FUNCTION fct_check_user_age() RETURNS trigger AS $$
BEGIN
  IF NEW.birthdate > CURRENT_DATE - INTERVAL '18 years' THEN
    RAISE EXCEPTION 'User must be at least 18 years old';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_enforce_user_age ON user_profile;
CREATE TRIGGER trg_enforce_user_age BEFORE INSERT OR UPDATE ON user_profile
FOR EACH ROW EXECUTE FUNCTION fct_check_user_age();

-- =========================================
-- USER PREFERENCES & PRESENCE
-- Les préférences guident la recherche. La présence réduit la précision GPS
-- et is_location_fresh permet d'ignorer une localisation obsolète.
-- =========================================
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id UUID PRIMARY KEY REFERENCES user_account(user_id) ON DELETE CASCADE,
  min_age INT NOT NULL DEFAULT 18,
  max_age INT NOT NULL DEFAULT 99,
  max_distance_km INT NOT NULL DEFAULT 50,
  looking_for TEXT NOT NULL DEFAULT 'male' CHECK (looking_for IN ('male', 'female', 'both', 'other')),
  CONSTRAINT chk_age_range CHECK (min_age >= 18 AND max_age >= min_age AND max_age <= 99),
  CONSTRAINT chk_distance CHECK (max_distance_km > 0)
);
CREATE TABLE IF NOT EXISTS user_presence (
  user_id UUID PRIMARY KEY REFERENCES user_account(user_id) ON DELETE CASCADE,
  latitude NUMERIC(9, 6),
  longitude NUMERIC(9, 6),
  is_location_fresh BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================================
-- TRAITS (PERSONNALITÉ)
-- Catalogue et table de liaison utilisateur/trait.
-- =========================================
CREATE TABLE IF NOT EXISTS trait (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS user_trait (
  user_id UUID REFERENCES user_account(user_id) ON DELETE CASCADE,
  trait_id UUID REFERENCES trait(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, trait_id)
);

-- =========================================
-- MATCHES
-- active dure 24 h ; awaiting_continuation ouvre une seconde fenêtre de 24 h.
-- confirmed est conservé ; expired est purgé après 30 jours par le job.
-- La révélation de photo et la continuation sont mémorisées par participant.
-- =========================================
CREATE TABLE IF NOT EXISTS match_init (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user1_id UUID NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  user2_id UUID NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'awaiting_continuation', 'confirmed', 'expired', 'ended')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours'),
  purge_after TIMESTAMPTZ,
  continuation_initiator_id UUID REFERENCES user_account(user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ,
  CHECK (user1_id < user2_id),
  UNIQUE (user1_id, user2_id)
);
CREATE INDEX IF NOT EXISTS idx_match_init_user1 ON match_init(user1_id);
CREATE INDEX IF NOT EXISTS idx_match_init_user2 ON match_init(user2_id);
CREATE INDEX IF NOT EXISTS idx_match_init_last_message ON match_init(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_match_init_to_expire ON match_init(expires_at) WHERE status IN ('active', 'awaiting_continuation');
CREATE INDEX IF NOT EXISTS idx_match_init_to_purge ON match_init(purge_after) WHERE status = 'expired';
CREATE TABLE IF NOT EXISTS match_state (
  match_id UUID NOT NULL REFERENCES match_init(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  revealed BOOLEAN NOT NULL DEFAULT false,
  continued BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (match_id, user_id)
);
CREATE TABLE IF NOT EXISTS continuation_usage (
  user_id UUID NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  used_count SMALLINT NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  PRIMARY KEY (user_id, week_start)
);

-- =========================================
-- MESSAGES
-- Les messages sont immuables côté utilisateur. Seul read_at est mis à jour.
-- =========================================
CREATE TABLE IF NOT EXISTS chat_message (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  match_id UUID NOT NULL REFERENCES match_init(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_message_match_created ON chat_message(match_id, created_at);

-- =========================================
-- REFRESH TOKENS (AUTH / SECURITY)
-- token_hash est la seule représentation persistée du secret de session.
-- =========================================
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  jti UUID NOT NULL UNIQUE,
  revoked BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_jti ON refresh_tokens(jti);

-- =========================================
-- USER REPORT (SIGNALEMENT)
-- Un même auteur ne peut conserver qu'un signalement pending par cible.
-- =========================================
CREATE TABLE IF NOT EXISTS user_report (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reporter_id UUID NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  reported_id UUID NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  match_id UUID REFERENCES match_init(id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK (reason IN ('inappropriate_content', 'fake_profile', 'harassment', 'spam', 'other')),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (reporter_id <> reported_id)
);
CREATE INDEX IF NOT EXISTS idx_user_report_status ON user_report(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_report_one_pending ON user_report(reporter_id, reported_id) WHERE status = 'pending';

-- =========================================
-- DEVICE TOKENS & NOTIFICATION INBOX
-- Les device tokens permettent les push ; les notifications expirent après 90 jours.
-- =========================================
CREATE TABLE IF NOT EXISTS device_token (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE, platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_used_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS notification (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID NOT NULL REFERENCES user_account(user_id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('new_match', 'new_message', 'profile_liked', 'match_expiring')),
  payload JSONB, read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '90 days')
);

-- =========================================
-- FONCTION D'ANONYMISATION (RGPD Art. 17)
-- Pseudonymise le compte, efface les données personnelles directes et anonymise
-- les messages afin de préserver l'intégrité des conversations restantes.
-- =========================================
CREATE OR REPLACE FUNCTION fct_anonymize_user(p_user_id UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE user_account SET phone_number_hash = 'anon_' || encode(gen_random_bytes(16), 'hex'), phone_number_encrypted = '',
    is_banned = false, banned_at = NULL, banned_reason = NULL, deleted_at = COALESCE(deleted_at, now()), anonymized_at = now()
  WHERE user_id = p_user_id;
  DELETE FROM user_profile WHERE user_id = p_user_id;
  DELETE FROM user_preferences WHERE user_id = p_user_id;
  DELETE FROM user_presence WHERE user_id = p_user_id;
  DELETE FROM refresh_tokens WHERE user_id = p_user_id;
  DELETE FROM device_token WHERE user_id = p_user_id;
  DELETE FROM notification WHERE user_id = p_user_id;
  UPDATE chat_message SET content = '[Message supprimé]' WHERE sender_id = p_user_id;
END;
$$;

-- =========================================
-- DONNÉES DE RÉFÉRENCE
-- Les insertions sont idempotentes et ne remplacent jamais une configuration existante.
-- =========================================
INSERT INTO subscription_plan (code, display_name, monthly_price_cents, annual_price_cents, currency, weekly_continuation_limit, trial_days)
VALUES ('free', 'Free', 0, 0, 'EUR', 3, 0), ('premium', 'Premium', 500, 3000, 'EUR', NULL, 30)
ON CONFLICT (code) DO NOTHING;
INSERT INTO subscription_plan_feature (plan_code, feature_code, display_name, description, feature_value, sort_order) VALUES
  ('free', 'messages', 'Messaging', 'Message participants while the match remains open.', '{"included":true}', 0),
  ('free', 'photo_reveal', 'Mutual photo reveal', 'Reveal profile photos after both participants agree.', '{"included":true}', 1),
  ('free', 'continuations', '3 continuations per week', 'Three successful match continuations each week.', '{"limit":3}', 2),
  ('premium', 'messages', 'Messaging', 'Message participants while the match remains open.', '{"included":true}', 0),
  ('premium', 'photo_reveal', 'Mutual photo reveal', 'Reveal profile photos after both participants agree.', '{"included":true}', 1),
  ('premium', 'continuations', 'Unlimited continuations', 'Continue matches without a weekly limit.', '{"limit":"unlimited"}', 2)
ON CONFLICT (plan_code, feature_code) DO NOTHING;
INSERT INTO trait (name) VALUES
  ('Curieux'), ('Bienveillant'), ('Créatif'), ('Aventurier'), ('À l''écoute'), ('Ambitieux'), ('Drôle'), ('Calme'),
  ('Sociable'), ('Empathique'), ('Optimiste'), ('Passionné'), ('Authentique'), ('Sportif'), ('Gourmand')
ON CONFLICT (name) DO NOTHING;
