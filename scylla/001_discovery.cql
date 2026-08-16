-- =========================================
-- SWIPES BY ACTOR BUCKET
-- Source canonique des décisions de découverte prises par un utilisateur.
--
-- Requêtes servies :
--   - vérifier si actor_id a déjà évalué un target_id précis
--   - exclure du feed un lot de profils déjà évalués
--   - vérifier le like réciproque target_id -> actor_id
--   - exporter uniquement les décisions prises par actor_id
--   - retrouver les références sortantes lors de l'effacement du compte
--
-- Modèle de concurrence :
--   - l'application écrit cette vue avec IF NOT EXISTS
--   - une décision like ou pass est donc immuable pendant sa conservation
--   - cette table fait autorité si la seconde vue doit être réparée après un retry
--
-- Partitionnement :
--   - bucket est calculé depuis le premier octet de target_id modulo 32
--   - les 32 partitions bornent la taille des données d'un acteur
--   - target_id est la clé de clustering et permet un lookup direct sans scan
--
-- RGPD et rétention :
--   - donnée comportementale conservée exactement 1 an
--   - effacement immédiat et croisé lors de la suppression du compte
--   - l'export utilisateur peut inclure ces lignes car ce sont ses propres choix
--
-- Compaction :
--   - TTL uniforme de 31 536 000 secondes défini au niveau de la table
--   - TWCS par fenêtres de 14 jours soit environ 26 fenêtres sur la rétention
--   - une réparation de miroir utilise seulement le TTL restant
-- =========================================
CREATE TABLE IF NOT EXISTS swipes_by_actor_bucket (
  actor_id UUID,          -- utilisateur qui prend la décision
  bucket TINYINT,         -- bucket déterministe dérivé de target_id, valeur de 0 à 31
  target_id UUID,         -- utilisateur évalué
  decision TEXT,          -- like ou pass, validation assurée par l'application
  swiped_at TIMESTAMP,    -- date de la première décision, conservée lors des retries
  PRIMARY KEY ((actor_id, bucket), target_id)
) WITH comment = 'Canonical immutable swipe decisions by actor for feed exclusion and reciprocal-like lookup'
  AND default_time_to_live = 31536000
  AND compaction = {
    'class': 'TimeWindowCompactionStrategy',
    'compaction_window_unit': 'DAYS',
    'compaction_window_size': '14'
  };


-- =========================================
-- SWIPES BY TARGET BUCKET
-- Vue dénormalisée interne des décisions reçues par un utilisateur.
--
-- Requêtes servies :
--   - vérifier directement si actor_id a liké target_id
--   - retrouver les références entrantes lors de l'effacement de target_id
--   - supprimer le miroir d'une action sortante lorsque son acteur est effacé
--
-- Confidentialité :
--   - cette vue n'est jamais exposée dans le feed ni dans l'export utilisateur
--   - la cible ne reçoit ni l'identité, ni la décision, ni un agrégat des tiers
--   - elle existe uniquement pour la réciprocité et l'effacement complet
--
-- Cohérence :
--   - cette table est un miroir de swipes_by_actor_bucket
--   - elle est écrite après la vue canonique
--   - si cette écriture échoue, un retry relit la décision canonique et répare le miroir
--   - la réparation réutilise swiped_at et le TTL restant pour ne pas prolonger la durée
--
-- Partitionnement :
--   - bucket est calculé depuis le premier octet de actor_id modulo 32
--   - le bucketing protège les cibles populaires contre une partition entrante unique
--   - actor_id est la clé de clustering et permet le lookup exact de la paire
--
-- RGPD, rétention et compaction :
--   - même TTL fixe d'un an que la vue canonique
--   - même stratégie TWCS et mêmes fenêtres de 14 jours
--   - suppression croisée et idempotente lors de l'effacement d'un des deux comptes
-- =========================================
CREATE TABLE IF NOT EXISTS swipes_by_target_bucket (
  target_id UUID,         -- utilisateur qui reçoit la décision sans jamais la voir
  bucket TINYINT,         -- bucket déterministe dérivé de actor_id, valeur de 0 à 31
  actor_id UUID,          -- utilisateur à l'origine de la décision
  decision TEXT,          -- copie interne de like ou pass
  swiped_at TIMESTAMP,    -- date originale provenant de la vue canonique
  PRIMARY KEY ((target_id, bucket), actor_id)
) WITH comment = 'Internal swipe mirror by target for reciprocal-like lookup and complete cross-reference erasure'
  AND default_time_to_live = 31536000
  AND compaction = {
    'class': 'TimeWindowCompactionStrategy',
    'compaction_window_unit': 'DAYS',
    'compaction_window_size': '14'
  };
