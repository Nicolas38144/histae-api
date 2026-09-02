CREATE TABLE profile_question (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT NOT NULL UNIQUE,
  prompt TEXT NOT NULL,
  category TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chk_profile_question_code CHECK (code ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT chk_profile_question_prompt CHECK (
    prompt = btrim(prompt)
    AND char_length(prompt) BETWEEN 3 AND 200
    AND octet_length(prompt) <= 500
  ),
  CONSTRAINT chk_profile_question_category CHECK (
    category IN ('daily_life', 'personality', 'interests', 'relationships', 'conversation')
  ),
  CONSTRAINT chk_profile_question_display_order CHECK (display_order BETWEEN 0 AND 10000)
);

CREATE UNIQUE INDEX uq_profile_question_prompt_ci ON profile_question (lower(prompt));
CREATE INDEX idx_profile_question_catalog ON profile_question (display_order, id);

CREATE TABLE user_profile_answer (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES user_profile(user_id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES profile_question(id) ON DELETE CASCADE,
  answer TEXT NOT NULL,
  position SMALLINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chk_user_profile_answer_text CHECK (
    answer = btrim(answer)
    AND char_length(answer) BETWEEN 10 AND 300
    AND octet_length(answer) <= 1000
  ),
  CONSTRAINT chk_user_profile_answer_position CHECK (position BETWEEN 1 AND 3),
  CONSTRAINT uq_user_profile_answer_question UNIQUE (user_id, question_id),
  CONSTRAINT uq_user_profile_answer_position UNIQUE (user_id, position)
);

CREATE INDEX idx_user_profile_answer_question ON user_profile_answer (question_id);

INSERT INTO profile_question (id, code, prompt, category, display_order) VALUES
  ('51000000-0000-4000-8000-000000000001', 'ideal_sunday', 'À quoi ressemble ton dimanche idéal ?', 'daily_life', 10),
  ('51000000-0000-4000-8000-000000000002', 'talk_for_hours', 'De quoi pourrais-tu parler pendant des heures ?', 'conversation', 20),
  ('51000000-0000-4000-8000-000000000003', 'small_joy', 'Quel petit plaisir améliore toujours ta journée ?', 'daily_life', 30),
  ('51000000-0000-4000-8000-000000000004', 'make_me_laugh', 'Qu’est-ce qui te fait rire à tous les coups ?', 'personality', 40),
  ('51000000-0000-4000-8000-000000000005', 'ideal_date', 'Quel serait ton rendez-vous idéal ?', 'relationships', 50),
  ('51000000-0000-4000-8000-000000000006', 'want_to_learn', 'Qu’aimerais-tu apprendre prochainement ?', 'interests', 60),
  ('51000000-0000-4000-8000-000000000007', 'valued_quality', 'Quelle qualité apprécies-tu le plus chez les autres ?', 'relationships', 70),
  ('51000000-0000-4000-8000-000000000008', 'useless_talent', 'Quel est ton talent le plus inutile ?', 'personality', 80),
  ('51000000-0000-4000-8000-000000000009', 'recent_surprise', 'Quelle est la dernière chose qui t’a agréablement surpris·e ?', 'conversation', 90),
  ('51000000-0000-4000-8000-000000000010', 'well_get_along_if', 'On s’entendra bien si…', 'relationships', 100),
  ('51000000-0000-4000-8000-000000000011', 'perfect_evening', 'Pour toi, une soirée réussie, c’est quoi ?', 'daily_life', 110),
  ('51000000-0000-4000-8000-000000000012', 'spontaneous_adventure', 'Quelle aventure spontanée serais-tu prêt·e à tenter ?', 'interests', 120),
  ('51000000-0000-4000-8000-000000000013', 'favorite_tradition', 'Quelle tradition aimerais-tu toujours conserver ?', 'daily_life', 130),
  ('51000000-0000-4000-8000-000000000014', 'current_curiosity', 'Qu’est-ce qui éveille ta curiosité en ce moment ?', 'interests', 140),
  ('51000000-0000-4000-8000-000000000015', 'comfort_food', 'Quel plat te réconforte instantanément ?', 'daily_life', 150);
