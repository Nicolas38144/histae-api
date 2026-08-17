# Histae API — résumé technique et fonctionnel détaillé

Mise à jour : 17 août 2026.

## 1. Vision du projet

Histae API est le backend TypeScript d’une application mobile de rencontres. Il centralise les contrats HTTP et les règles métier tout en mettant l’accent sur l’architecture, la sécurité, la traçabilité et la conformité RGPD.

La version actuelle fournit :

- l’authentification et les sessions ;
- l’onboarding juridique de l’utilisateur ;
- le profil, les préférences, les traits et la localisation ;
- les plans d’abonnement et le quota de continuation ;
- le cycle de vie des matchs ;
- la messagerie ;
- les signalements et actions de modération ;
- les blocages entre utilisateurs ;
- l’export des données et les demandes d’exercice des droits ;
- l’effacement et l’anonymisation ;
- les politiques de rétention ;
- les migrations, la maintenance, la documentation OpenAPI et les sondes d’exploitation.
- le feed de découverte, les décisions de swipe et la création de matchs par likes réciproques avec ScyllaDB.

Un ensemble fonctionnel reste volontairement incomplet :

1. les paiements et webhooks d’abonnement.

## 2. État global

Les sept refactors prioritaires précédemment identifiés ont été traités :

1. transitions de match et messagerie rendues atomiques ;
2. types métier fermés et validation stricte de la date de naissance ;
3. consentements, demandes RGPD, blocages, export et effacement ;
4. migrations, pool PostgreSQL, maintenance et observabilité fiabilisés ;
5. pagination par curseur et réponses OpenAPI explicites ;
6. ESLint, typecheck et tests renforcés ;
7. documentation et politique de rétention formalisées.

Le typecheck strict, les tests isolés et une suite de dix scénarios contre le Scylla local couvrent la nouvelle
découverte. Cette suite valide les deux vues, les LWT, les likes simultanés, le feed, la réparation du miroir,
l’effacement croisé, la confidentialité de l’export, un TTL court par écriture et le mapping métier `503`.
PostgreSQL utilise uniquement `histae-dev`; Scylla utilise `histae_discovery` avec uniquement des UUID temporaires,
un nettoyage ciblé et sans `DROP`, `TRUNCATE` ni `ALTER TABLE`.

## 3. Stack technique

| Élément | Choix actuel |
| --- | --- |
| Langage | TypeScript strict |
| Framework | NestJS 11 |
| Serveur HTTP | Fastify 5 via `@nestjs/platform-fastify` |
| Base principale | PostgreSQL |
| Base de décisions de découverte | ScyllaDB 2026.2, via `cassandra-driver` 4.9 |
| Rate limiting distribué | Redis 7.4 local et production ; mémoire uniquement en repli explicite |
| Authentification | JWT HS256 + refresh tokens rotatifs |
| Validation | `class-validator` et `class-transformer` |
| Documentation | `@nestjs/swagger`, Swagger UI et document OpenAPI JSON |
| Tests | Jest 30, `ts-jest`, Fastify injection et PostgreSQL réel |
| Qualité | ESLint 10, `typescript-eslint`, `tsc --noEmit` |
| Package manager | pnpm avec lockfile |

Le préfixe applicatif historique `/api` est conservé. Les exceptions sont `/health/live`, `/health/ready`, `/docs` et `/docs-json`.

## 4. Organisation du code

Le code est découpé par domaine. Chaque domaine suit autant que possible la même séparation :

- `controller` : contrat HTTP, guards, DTO et statut de réponse ;
- `dto` : validation des entrées et description des réponses Swagger ;
- `service` : règles métier et traduction en erreurs API ;
- `repository` : SQL, transactions et verrous PostgreSQL ;
- `models` : unions fermées et structures internes ;
- `mapper` : conversion des lignes SQL vers la représentation publique.

Les principaux modules sont :

| Module | Responsabilités |
| --- | --- |
| `auth` | OTP, comptes, JWT, refresh tokens, guards et rôles |
| `users` | profil, préférences, localisation et choix juridiques |
| `privacy` | demandes RGPD, export, blocages, journaux d’accès et rétention |
| `matches` | création, liste, révélation, continuation, quota, messages et maintenance |
| `reports` | signalements utilisateur et traitement administrateur |
| `traits` | catalogue et attribution de traits |
| `plans` | plans Free/Premium et fonctionnalités commerciales |
| `discovery` | éligibilité et distance PostgreSQL, exclusions et swipes Scylla, likes réciproques et création de match |
| `common` | erreurs, validation HTTP, pagination et DTO génériques |
| `config` | validation centralisée de l’environnement |
| `database` | pool et transactions PostgreSQL |
| `redis` | connexion partagée, compteur atomique et readiness Redis |
| `ratelimit` | limites mémoire ou Redis |

`CoreModule` est global et fournit une instance partagée de `ConfigService`, `DatabaseService`, `ScyllaService`,
`RedisService` et `RateLimitService`. La configuration n’est plus instanciée séparément dans `main.ts` et dans Nest, ce qui
évite les divergences de valeurs.

## 5. Contrat HTTP commun

### Validation

- Les corps, paramètres d’URL et query strings sont transformés en DTO.
- Les champs non documentés sont refusés.
- Les champs obligatoires absents ou invalides produisent une erreur stable.
- Fastify limite le corps JSON à 1 Mio.
- La date de naissance accepte uniquement une date calendrier stricte `YYYY-MM-DD`.
- La date est normalisée et revalidée pour refuser les dates impossibles telles que `2000-02-30`.

### Erreurs

Toutes les erreurs publiques suivent cette enveloppe :

```json
{
  "error": {
    "code": "stable_machine_code",
    "message": "Human-readable message"
  }
}
```

Les erreurs inattendues et les erreurs serveur sont journalisées côté API, mais leur stack n’est jamais renvoyée au client.

### Identifiant de requête

- Un `X-Request-ID` UUID valide fourni par le client est conservé.
- Sinon, l’API génère un UUID.
- L’identifiant est renvoyé dans la réponse et inclus dans les logs HTTP.
- La durée en millisecondes, la méthode, l’URL et le statut sont journalisés.

## 6. Configuration et démarrage sécurisé

`ENV` est obligatoire et doit valoir `development`, `test` ou `production`. Une valeur absente ou approximative échoue au démarrage.

### Secrets et paramètres essentiels

- `JWT_SECRET` : au moins 32 octets ;
- `PHONE_ENCRYPTION_KEY` : clé AES-256-GCM ;
- `PHONE_HASH_KEY` : clé HMAC-SHA-256 ;
- paramètres PostgreSQL ;
- versions et URL des quatre documents juridiques ;
- `LEGAL_REVIEW_REFERENCE` en production ;
- Redis avec TLS et mot de passe en production pour le rate limiting partagé ;
- ScyllaDB activée en production, avec TLS, authentification et facteur de réplication explicite ;
- `SMS_PROVIDER`, `SWEEGO_API_KEY`, `SWEEGO_API_URL`, `SWEEGO_SMS_SENDER_ID`, `SWEEGO_SMS_REGION`, `SWEEGO_TIMEOUT` et `OTP_TTL` pour la livraison des OTP.

`.env.example` inventorie les variables prises en charge tandis que `.env` reste ignoré. Les clés `JWT_SECRET`, `PHONE_ENCRYPTION_KEY`, `PHONE_HASH_KEY` et `SWEEGO_API_KEY` y restent vides.

### Pool PostgreSQL

Les valeurs par défaut sont :

- maximum de 20 connexions ;
- connexion : 5 secondes ;
- connexion inactive : 30 secondes ;
- requête SQL : 15 secondes ;
- transaction inactive : 30 secondes.

Ces valeurs sont configurables avec `POSTGRES_POOL_MAX`, `POSTGRES_CONNECT_TIMEOUT`, `POSTGRES_IDLE_TIMEOUT`, `POSTGRES_STATEMENT_TIMEOUT` et `POSTGRES_IDLE_TRANSACTION_TIMEOUT`.

### Arrêt propre

Nest active les shutdown hooks. À l’arrêt :

- le pool PostgreSQL est fermé ;
- le client ScyllaDB est arrêté ;
- la connexion Redis est quittée proprement ;
- les timers de maintenance embarqués sont annulés.

## 7. Authentification et sécurité des comptes

### Téléphone

- Le numéro est normalisé au format E.164 et limité actuellement à la France (`+33` suivi de neuf chiffres sans zéro national).
- Il est chiffré avec AES-256-GCM pour les cas nécessitant sa récupération.
- Un HMAC-SHA-256 déterministe est stocké pour l’unicité et les recherches.
- Le numéro en clair n’est pas persisté.

### OTP

`POST /api/auth/otp/send` livre désormais un SMS transactionnel réel avec Sweego. La requête exige un en-tête `Idempotency-Key` UUID v4. L’API persiste d’abord le hash du code avec l’état `pending`, appelle Sweego avec un délai maximal, puis rend le code utilisable seulement après une réponse HTTP `200` contenant les identifiants de transaction et de message attendus. Une demande restée `pending` au-delà du timeout fournisseur et de cinq secondes de grâce est marquée `failed` lors de son prochain retry. Les états `pending`, `sent` et `failed`, l’identifiant de campagne et les identifiants fournisseur restent traçables sans persister le code en clair.

L’idempotence est garantie au niveau applicatif : rejouer la même clé pour le même numéro ne déclenche pas un second appel, tandis qu’une réutilisation pour un autre numéro renvoie `409`. L’activation d’un OTP acquiert un verrou transactionnel dérivé du hash téléphone ; un index PostgreSQL unique impose en complément un seul code `sent` non utilisé par téléphone. Aucun système distribué ne peut rendre atomiques une transaction PostgreSQL et un appel HTTP externe : si Sweego accepte un SMS mais que sa réponse est perdue, le code reste volontairement inutilisable et un retry avec une nouvelle clé peut produire un second SMS. Un suivi de livraison par webhook reste donc souhaitable pour l’observabilité opérationnelle.

### Access tokens

- JWT signé explicitement en HS256 ;
- durée par défaut : 15 minutes ;
- sujet `sub` limité à l’UUID utilisateur ;
- les rôles ne sont pas considérés comme fiables depuis le token.

À chaque requête authentifiée, le guard relit PostgreSQL pour vérifier :

- que le compte existe ;
- qu’il n’est pas supprimé ;
- qu’il n’est pas banni ;
- que son rôle actuel permet éventuellement l’accès admin ;
- que l’onboarding juridique est complet pour une route utilisateur normale.

### Refresh tokens

- Format public `jti:secret`.
- Seul le hash SHA-256 du token complet est persisté.
- Rotation atomique sous verrou PostgreSQL.
- Ancien token révoqué lors d’un refresh réussi.
- Déconnexion idempotente pour un token appartenant à l’utilisateur.
- Durée par défaut : 4 320 heures, soit 180 jours.

### Rôles

Les rôles fermés sont `user`, `admin` et `superadmin`.

- La vérification d’un OTP crée un compte `user` lorsque le téléphone n’est pas encore connu.
- Le client ne peut pas fournir son rôle et l’API n’expose aucune route de création de compte privilégié.

### Tombstone de sécurité

Lorsqu’un compte banni est effacé, son HMAC de téléphone est placé dans `account_tombstone` pendant trois ans. Cela limite le contournement immédiat d’une sanction sans conserver le profil ni le téléphone chiffré. Un compte non banni effacé ne produit pas de tombstone.

## 8. Onboarding et choix juridiques

Histae ne fait aucun marketing et ne possède aucun consentement « actualités et offres ».

Les quatre choix reconnus sont :

1. `terms_of_service_acceptance` — acceptation contractuelle des CGU ;
2. `privacy_notice_acknowledgement` — accusé de présentation de la notice de confidentialité ;
3. `sensitive_data_consent` — consentement explicite aux données sensibles concernées ;
4. `location_consent` — consentement au traitement de la localisation.

Les quatre documents ont chacun :

- une version configurée ;
- une URL absolue configurée ;
- une preuve d’événement en base ;
- une date PostgreSQL ;
- une séquence globale monotone ;
- éventuellement IP et user-agent pour la preuve technique.

En production, les URL doivent utiliser HTTPS. Les versions, les URL et `LEGAL_REVIEW_REFERENCE` sont obligatoires.

### Traduction côté mobile

1. Après la création de session, le mobile appelle `GET /api/users/me/consents`.
2. La réponse contient les quatre choix, leur état, l’éventuelle `document_version` acceptée, `required_document_version`, `document_url`, `onboarding_complete` et `required_actions`.
3. Le mobile affiche séparément les CGU et la notice, sans case précochée.
4. Les choix sont envoyés par `PUT /api/users/me/consents`.
5. Tant que les deux documents obligatoires ne sont pas courants, les routes utilisateur normales répondent `403 onboarding_incomplete`.
6. Les routes indispensables restent accessibles : consultation/mise à jour des choix, déconnexion, demandes RGPD, export et suppression du compte.
7. Le consentement sensible est demandé juste avant de renseigner les données concernées.
8. Le consentement de localisation est demandé au moment de l’activation, en plus de l’autorisation native iOS/Android.

L’acceptation des CGU et l’accusé de présentation ne sont pas modélisés comme des consentements librement retirables par `granted=false`. L’utilisateur peut les refuser pendant l’inscription ou supprimer son compte. Les consentements sensible et de localisation peuvent être retirés.

### Effets du retrait

- Retrait sensible : suppression du sexe et des préférences concernées.
- Retrait de localisation : suppression immédiate de la ligne de présence.
- Les événements retirés restent conservés selon la politique de preuve, sans redevenir actifs.

### Concurrence

Les écritures de choix juridiques :

- verrouillent le compte utilisateur ;
- utilisent l’horloge PostgreSQL ;
- ordonnent les événements par `event_sequence` ;
- garantissent un seul événement actif par utilisateur et type ;
- sont idempotentes lorsqu’un retry mobile répète exactement le choix courant.

## 9. Profil, préférences, traits et localisation

### Profil

- `firstname` obligatoire, non vide, maximum 100 octets ;
- `birthdate` obligatoire au format `YYYY-MM-DD` ;
- majorité calculée en calendrier UTC ;
- contrainte PostgreSQL supplémentaire garantissant 18 ans ;
- `sex` fermé à `male`, `female`, `other` ou `null` ;
- bio : 2 000 octets maximum ;
- photo : URL HTTP(S), 2 048 octets maximum.

Les CGU et la notice courantes sont requises. Un sexe non nul exige aussi le consentement sensible courant.

### Préférences

- âge minimum : au moins 18 ;
- âge maximum : au plus 99 et supérieur ou égal au minimum ;
- distance : entier entre 1 et 500 km ;
- `looking_for` : `male`, `female`, `both` ou `other` ;
- consentement sensible courant obligatoire.

### Traits

- catalogue administrable ;
- nom non vide, 100 octets maximum ;
- attribution utilisateur idempotente ;
- suppression d’une attribution idempotente ;
- unicité du nom et UUID des traits.

### Localisation

- latitude entre -90 et 90 ;
- longitude entre -180 et 180 ;
- consentement de localisation courant obligatoire ;
- marquée obsolète après une heure ;
- supprimée après 24 heures ;
- supprimée immédiatement au retrait du consentement ou à l’effacement du compte.

## 10. Découverte, feed et swipes

La découverte utilise une architecture hybride. PostgreSQL reste la source canonique des informations qui
doivent être cohérentes transactionnellement : compte actif, profil, préférences, consentements, présence,
blocages et matchs. ScyllaDB conserve les décisions à fort volume et répond aux exclusions du feed et à la
recherche du like réciproque. Le feed dépend donc réellement des deux bases, sans dupliquer les profils dans
Scylla ni introduire une synchronisation fragile de données personnelles.

### Conditions de disponibilité

Un utilisateur est prêt pour la découverte uniquement s’il possède :

- un compte actif et non banni ;
- un profil avec `sex` renseigné ;
- des préférences complètes ;
- la version courante de `sensitive_data_consent` ;
- la version courante de `location_consent` ;
- une présence fraîche, mise à jour depuis moins d’une heure.

Une tentative avant cet état renvoie `409 discovery_not_ready`. Une cible supprimée, bannie, incomplète,
bloquée dans l’un ou l’autre sens, ou déjà liée par un match est présentée comme indisponible avec
`404 discovery_candidate_not_found`.

### Construction du feed

`GET /api/feed` accepte `limit` de 1 à 100 et un curseur opaque. PostgreSQL :

1. charge les critères du demandeur ;
2. applique une boîte géographique avant le calcul exact de Haversine ;
3. applique dans les deux sens les âges acceptés, le sexe recherché et la distance maximale ;
4. impose aux candidats des consentements courants et une présence fraîche ;
5. exclut les blocages et les matchs existants ;
6. ordonne par distance exacte puis UUID.

Scylla exclut ensuite les cibles pour lesquelles le demandeur a déjà enregistré `like` ou `pass`. L’API
sur-échantillonne les lots PostgreSQL afin de remplir la page malgré ces exclusions. Le curseur conserve la
distance exacte pour éviter sauts et doublons ; la réponse publique arrondit la distance au dixième de
kilomètre. Le profil de feed expose le prénom, l’âge calculé, le sexe, la bio, la distance et les traits. Il
n’expose ni la date de naissance exacte ni la photo, cohérent avec la révélation mutuelle des photos.

### Écriture d’un swipe et création du match

`POST /api/swipes` accepte exactement `like` ou `pass`. Une décision est immuable pendant sa durée de
conservation. La table acteur est écrite avec `IF NOT EXISTS`, puis la vue cible est écrite/réparée avec le TTL
restant. Un retry identique est idempotent ; une tentative de remplacer `pass` par `like`, ou inversement,
renvoie `409 swipe_already_recorded`.

Après un `like`, le service lit la partition acteur de l’autre utilisateur. Si elle contient aussi un `like`,
le match est créé dans une transaction PostgreSQL. La contrainte unique sur la paire ordonnée absorbe deux
requêtes réciproques concurrentes : les deux appels peuvent observer le même match, mais une seule ligne est
créée. Le repository de match revérifie les blocages au moment de l’écriture afin de fermer la course entre le
contrôle d’éligibilité et la création.

### Modèle Scylla orienté requêtes

Le keyspace `histae_discovery` contient :

- `swipes_by_actor_bucket ((actor_id, bucket), target_id)` pour l’exclusion du feed, l’idempotence, la
  réciprocité sortante et l’export ;
- `swipes_by_target_bucket ((target_id, bucket), actor_id)` pour retrouver un like réciproque et effacer
  complètement les références croisées. Ces choix entrants restent internes et ne sont jamais exposés à la cible.

Les UUID sont répartis dans 32 buckets déterministes. Cela borne la taille des partitions sans index secondaire
ni `ALLOW FILTERING`. Les deux tables imposent un TTL fixe d’un an avec
`default_time_to_live = 31536000` et utilisent TWCS par fenêtres de quatorze jours. Le runtime n’accepte plus
de TTL configurable qui pourrait produire des durées divergentes. Si l’écriture de la seconde vue échoue après la première, le client reçoit `503` ;
le retry relit la décision canonique et répare la vue cible. Les lectures/écritures utilisent `LOCAL_QUORUM` et
les LWT `LOCAL_SERIAL`.

### Effacement et disponibilité

L’export portable inclut uniquement les actions sortantes décidées par l’utilisateur. Les actions entrantes
servent en interne à la réciprocité et à l’effacement, mais ne sont jamais révélées à la cible. L’effacement lit les deux sens, supprime chaque
miroir chez les autres utilisateurs, puis supprime les 32 partitions propres dans les deux tables. Les
opérations sont idempotentes et bornées en concurrence. Si Scylla est indisponible, le service ne prétend pas
avoir terminé un export ou un effacement complet : il renvoie respectivement `503 data_export_unavailable` ou
`503 data_erasure_unavailable`.

`SCYLLA_ENABLED=false` garde le développement sans Scylla possible, mais les routes de découverte répondent
alors `503 discovery_unavailable`. La production refuse de démarrer sans Scylla activée, TLS et identifiants.
La sonde de readiness interroge Scylla lorsqu’elle est activée.

## 11. Plans et quota de continuation

Le catalogue PostgreSQL expose les plans, prix mensuel/annuel en centimes, devise, essai, limite hebdomadaire et fonctionnalités JSON.

- L’absence de `user_subscription` équivaut au plan Free.
- Un abonnement expiré retombe sur Free.
- Une limite `NULL` représente un quota illimité.
- `continuation_usage` comptabilise l’usage par semaine UTC.
- Le quota n’est consommé qu’au second consentement, lorsque la continuation devient mutuelle.
- Le quota débité appartient à l’initiateur de la continuation.

L’API sait lire les droits, mais aucun paiement ni webhook ne met encore à jour les abonnements.

## 12. Matchs : modèle et machine d’état

Les statuts fermés sont :

- `active` ;
- `awaiting_continuation` ;
- `confirmed` ;
- `expired` ;
- `ended`.

### Cycle normal

```text
création
   │
   ▼
active pendant 24 h
   │ échéance
   ▼
awaiting_continuation pendant 24 h
   ├── deux consentements ──► confirmed
   └── échéance ─────────────► expired ──► purge après 30 jours
```

Un blocage ou un effacement transforme un match en `ended` et programme sa purge sous trente jours.

### Atomicité

La disponibilité n’est plus vérifiée dans une requête séparée de l’écriture. Les opérations importantes verrouillent le match avec `FOR UPDATE`, lisent l’heure PostgreSQL, appliquent l’éventuelle transition, puis écrivent dans la même transaction.

Cela concerne :

- révélation des photos ;
- lecture des messages ;
- création d’un message ;
- ouverture/expiration de la fenêtre de continuation ;
- premier et second consentements de continuation ;
- consommation du quota.

Cette structure évite qu’un message soit inséré après l’expiration observée par une autre transaction ou que le quota soit consommé deux fois.

### Révélation

Chaque participant possède une ligne `match_state`. La photo n’est considérée comme révélée que si les deux lignes ont `revealed=true`. Ce consentement est distinct de la continuation.

### Messagerie

- réservée aux participants ;
- disponible pour les états autorisés ;
- contenu non vide, 2 000 caractères maximum ;
- message horodaté avec `clock_timestamp()` ;
- `last_message_at` mis à jour dans la même transaction ;
- seul le destinataire peut marquer le message comme lu ;
- un match expiré refuse atomiquement l’insertion.

### Blocage

- Un utilisateur ne peut pas se bloquer lui-même.
- Le blocage est idempotent.
- Les matchs actifs, en attente ou confirmés de la paire deviennent `ended`.
- Les listes de matchs masquent toute paire bloquée dans un sens ou dans l’autre.
- Une transaction empêche la création d’un nouveau match tant que le blocage existe.

## 13. Pagination

Les listes à fort volume utilisent une pagination keyset :

- feed, par distance exacte et UUID ;
- matchs ;
- messages ;
- signalements administrateur.

Chaque réponse renvoie `next_cursor`, qui vaut une chaîne opaque ou `null`. Le client transmet cette valeur dans `cursor` pour la page suivante.

Le curseur contient en interne :

- l’horodatage SQL exact ;
- l’UUID de départage.

Pour les messages, la précision PostgreSQL à six décimales est conservée sous forme textuelle. Cette précaution évite les lignes sautées lorsque plusieurs messages sont créés dans la même milliseconde et que le pilote Node tronque les microsecondes dans un objet `Date`.

`offset` reste accepté pour compatibilité avec les anciens clients, mais il est documenté comme déprécié et doit valoir zéro lorsqu’un curseur est fourni.

Les index dédiés suivent exactement les ordres de tri utilisés.

## 14. Signalements et administration

Les motifs fermés sont :

- `inappropriate_content` ;
- `fake_profile` ;
- `harassment` ;
- `spam` ;
- `other`.

Les statuts sont `pending`, `reviewed` et `dismissed`.

Règles :

- auto-signalement interdit ;
- cible active obligatoire ;
- si un match est fourni, il doit relier le déclarant et la cible ;
- description limitée à 2 000 octets ;
- un seul signalement en attente par déclarant/cible/match ;
- rate limit dédié ;
- changement de statut administrateur transactionnel ;
- chaque revue écrit `admin_review_report` dans `data_access_log`.

## 15. Droits RGPD et export

### Types de demande

`data_subject_request` accepte :

- `access` ;
- `erasure` ;
- `portability` ;
- `rectification` ;
- `restriction` ;
- `objection`.

### Statuts et transitions

- création en `pending` ;
- passage possible à `in_progress` ou `rejected` ;
- depuis `in_progress`, passage à `completed` ou `rejected` ;
- transitions terminales non rejouables ;
- une seule demande ouverte par utilisateur et type ;
- traitement administrateur journalisé avec rôle, administrateur, motif et date.

Terminer une demande `erasure` appelle la fonction PostgreSQL d’anonymisation dans la même transaction.
Avant l’anonymisation PostgreSQL, le callback d’effacement supprime toutes les références de swipe dans
Scylla. Un échec Scylla annule la transaction PostgreSQL et laisse la demande en cours, afin qu’un retry
idempotent puisse terminer les deux côtés sans déclarer prématurément la demande accomplie.

### Export portable

`GET /api/users/me/data-export` assemble transactionnellement :

- compte technique ;
- profil ;
- préférences ;
- traits ;
- historique des choix juridiques ;
- matchs ;
- messages écrits ;
- signalements soumis ;
- blocages créés ;
- abonnement.
- décisions de découverte sortantes prises par l’utilisateur et provenant de ScyllaDB ; les choix entrants de tiers sont exclus de la réponse.

L’export est journalisé avec `export_data`. Il reste accessible pendant un onboarding incomplet afin de ne pas conditionner l’exercice des droits à l’acceptation des CGU.

### Journal des accès

`data_access_log` peut tracer notamment :

- consultation de profil, matchs et messages ;
- export ;
- bannissement/débannissement ;
- revue d’un signalement ;
- traitement d’une demande RGPD ;
- anonymisation système ;
- export de portabilité.

Les journaux sont réservés à l’administration et limités à 500 lignes par consultation.

## 16. Effacement et anonymisation

L’effacement ne se limite pas à mettre `deleted_at`.

### Suppressions immédiates

- profil ;
- préférences ;
- traits utilisateur ;
- localisation ;
- refresh tokens ;
- tokens d’appareil ;
- notifications ;
- blocages entrants et sortants ;
- abonnement ;
- compteurs de continuation ;
- état individuel dans les matchs.
- swipes entrants et sortants dans les deux vues ScyllaDB.

### Anonymisation et retrait

- téléphone chiffré vidé ;
- HMAC remplacé par une valeur aléatoire `anon_*` ;
- bannissement et informations administratives retirés du compte ;
- `deleted_at` et `anonymized_at` renseignés ;
- consentements retirés ;
- IP et user-agent des preuves supprimés ;
- contenu des messages écrits remplacé par `[Message supprimé]`.

### Relations résiduelles

- matchs clôturés en `ended` ;
- purge programmée sous trente jours ;
- signalements et preuves nécessaires suivent leur propre durée de conservation ;
- UUID technique pseudonyme conservé tant qu’une relation encore légitime le référence.

L’objectif est d’effacer les données de profil et d’authentification immédiatement tout en préservant temporairement l’intégrité, la sécurité des autres utilisateurs et la preuve des opérations légitimes.

## 17. Politiques de rétention

| Donnée | Politique actuelle |
| --- | --- |
| Position | obsolète après 1 h, supprimée après 24 h |
| OTP | supprimé après `expires_at` |
| Refresh token | supprimé après expiration, révocation ou effacement |
| Notification | supprimée après `expires_at`, 90 jours par défaut |
| Preuve de choix retiré | 5 ans après retrait |
| Demande RGPD clôturée/rejetée | 5 ans après clôture |
| Journal d’accès | 1 an |
| Signalement résolu | 3 ans |
| Match expiré ou terminé | purge après 30 jours |
| Tombstone de compte banni | 3 ans |
| Décision de swipe | TTL Scylla fixe de 1 an, TWCS 14 jours, effacement immédiat avec le compte |

Les suppressions sont exécutées par lots de 1 000 lignes, jusqu’à 100 lots par passage, afin de limiter la taille des transactions et les pics de verrouillage.

La matrice détaillée, les finalités et les points à faire approuver figurent dans [`docs/retention-policy.md`](docs/retention-policy.md).

## 18. Validation juridique

Le code garantit que la production ne démarre pas sans :

- les quatre versions juridiques ;
- les quatre URL HTTPS ;
- une valeur `LEGAL_REVIEW_REFERENCE`.

Ce mécanisme est un verrou de déploiement, pas une certification. Une valeur inventée ne constitue pas une validation juridique. Une approbation réelle par un juriste ou DPO doit préciser l’auteur, la date, le périmètre, les textes, les finalités, les durées, les destinataires et l’analyse d’impact éventuelle.

Les points encore à faire valider comprennent notamment :

- la qualification exacte des données `sex` et `looking_for` ;
- les durées de trois ans pour signalements et tombstones ;
- les transferts, sous-traitants et sauvegardes ;
- la rédaction mobile des consentements ;
- la politique de comptes inactifs ;
- la nécessité et le contenu de l’AIPD.

La procédure est décrite dans [`docs/legal-release-checklist.md`](docs/legal-release-checklist.md).

## 19. Stockage PostgreSQL et ScyllaDB

Le schéma canonique contient 23 tables :

1. `user_account` ;
2. `account_tombstone` ;
3. `subscription_plan` ;
4. `subscription_plan_feature` ;
5. `user_subscription` ;
6. `user_consent` ;
7. `data_subject_request` ;
8. `data_access_log` ;
9. `otp_verification` ;
10. `user_profile` ;
11. `user_preferences` ;
12. `user_presence` ;
13. `trait` ;
14. `user_trait` ;
15. `match_init` ;
16. `match_state` ;
17. `continuation_usage` ;
18. `chat_message` ;
19. `refresh_tokens` ;
20. `user_block` ;
21. `user_report` ;
22. `device_token` ;
23. `notification`.

Les relations utilisent largement `ON DELETE CASCADE` ou `SET NULL` selon le besoin métier. Les contraintes SQL doublent les validations critiques : rôles, statuts, types de consentement, sexe, préférences, majorité, prix et limites.

Deux fonctions principales complètent le schéma :

- `fct_anonymize_user` pour l’effacement RGPD ;
- `fct_check_user_age` avec trigger avant insertion/mise à jour du profil.

Les index conservés couvrent :

- recherche par téléphone HMAC via la contrainte unique, sans index B-tree dupliqué ;
- consentements actifs et ordre des événements ;
- demandes ouvertes ;
- journaux d’accès ;
- recherche géographique ;
- participants et échéances des matchs ;
- pagination des matchs/messages/signalements ;
- refresh tokens par utilisateur, par JTI unique et par date d’expiration ;
- blocages ;
- signalements en attente ;
- notifications non lues et expirées.

La migration `008` retire neuf index redondants, remplacés ou sans requête correspondante : doublons du hash téléphone et du JTI, ancien index des messages, index simple du statut des signalements, index simple des consentements, ancien tri par dernier message, index des comptes actifs, index d’anonymisation différée et ancien index partiel des refresh tokens. Ce dernier est remplacé par `idx_refresh_tokens_expires(expires_at)`, aligné sur la purge globale réellement exécutée. La migration `010` retire ensuite l’ancien index partiel des OTP utilisables, devenu redondant avec la contrainte unique par téléphone.

ScyllaDB n’utilise volontairement aucun index secondaire. Les deux tables CQL sont dénormalisées selon leurs
requêtes exactes, réparties en 32 partitions logiques par utilisateur et nettoyées par TTL. Les profils et
autres données de référence ne sont pas copiés dans Scylla : cela réduit les conflits de cohérence, limite les
données à effacer et permet à PostgreSQL de rester l’autorité pour les règles relationnelles.

## 20. Migrations

Les migrations versionnées sont :

| Version | Rôle principal |
| --- | --- |
| `001_api_contract` | contrat PostgreSQL initial compatible avec l’API |
| `002_privacy_and_schema_parity` | alignement du schéma et premières structures privacy |
| `003_legal_choice_semantics` | sémantique des quatre choix juridiques, sans marketing |
| `004_consent_event_order` | ordre monotone et concurrence des événements |
| `005_strict_profile_age` | majorité calendrier stricte |
| `006_privacy_workflows` | demandes RGPD, accès, blocages, tombstones et anonymisation étendue |
| `007_keyset_pagination_indexes` | index des paginations par curseur |
| `008_index_cleanup` | suppression de neuf index redondants ou obsolètes et indexation directe de l’expiration des refresh tokens |
| `009_otp_sms_delivery` | idempotence des demandes OTP, états de livraison Sweego et identifiants fournisseur |
| `010_single_usable_otp` | reprise des doublons historiques, remplacement de l’ancien index partiel et contrainte d’un seul OTP utilisable par téléphone |

Le moteur de migration :

- acquiert un verrou consultatif de session ;
- applique chaque fichier dans une transaction ;
- enregistre version, checksum SHA-256 et date ;
- refuse un checksum modifié pour une migration déjà appliquée ;
- permet des exécutions répétées sans réappliquer les migrations.

`pnpm run db:reset` est distinct : il reconstruit le schéma canonique et les catalogues uniquement avec `ENV=development`, la base `histae-dev` et un hôte PostgreSQL local.

Les deux chemins sont maintenus en parité : le reset canonique produit directement le schéma final et les dix migrations conduisent au même ensemble d’index.

Le schéma Scylla suit un registre séparé `scylla_schema_migrations`. `pnpm run scylla:migrate` crée le keyspace
avec `NetworkTopologyStrategy`, applique `scylla/001_discovery.cql`, enregistre son SHA-256 et refuse toute
modification silencieuse d’un fichier déjà appliqué. `docker-compose.scylla.yml` fournit un nœud local de
développement ; le facteur de réplication vaut 1 localement et 3 par défaut en production.

`pnpm run db:reset-scylla` vide uniquement les deux vues applicatives de swipes par `TRUNCATE`. La commande
conserve le keyspace, les tables, leurs TTL/TWCS et `scylla_schema_migrations`. Elle refuse tout environnement autre que `development`, tout keyspace
autre que `histae_discovery`, Scylla désactivé et tout contact point non local.

## 21. Maintenance

Deux familles de maintenance existent :

### Matchs

- ouverture des fenêtres de continuation arrivées à échéance ;
- expiration de la seconde fenêtre ;
- purge des matchs expirés ou terminés.

### Vie privée

- obsolescence et suppression de position ;
- OTP, refresh tokens et notifications expirés ;
- preuves de consentement retirées ;
- demandes RGPD ;
- journaux d’accès ;
- signalements résolus ;
- tombstones expirés.

Chaque famille utilise un verrou consultatif transactionnel PostgreSQL. Deux workers concurrents ne traitent donc pas le même cycle en parallèle.

Modes :

- `api` : timers embarqués, pratique en développement ;
- `worker` : exécution ponctuelle par `pnpm run maintenance:run` ;
- `disabled` : aucune maintenance embarquée.

En production, la recommandation est :

- API avec `MAINTENANCE_MODE=disabled` ;
- CronJob ou ordonnanceur avec `MAINTENANCE_MODE=worker`.

Le worker réel a été exécuté avec succès contre la base PostgreSQL locale de développement.

## 22. Rate limiting

Limites par défaut :

| Périmètre | Limite |
| --- | --- |
| Global par IP | 100 requêtes par minute |
| Envoi/vérification OTP | 5 par heure, à la fois par IP et numéro pseudonymisé |
| Rotation de refresh token | 30 par 15 minutes et IP |
| Feed | 60 par minute et utilisateur |
| Envoi de message | 60 par minute et utilisateur |
| Export RGPD | 5 par heure et utilisateur |
| Signalement | 5 par heure et utilisateur |
| Swipe | 120 par minute et utilisateur |

Le développement local utilise maintenant Redis comme la production. Le script Lua incrémente et pose
l’expiration atomiquement, ce qui partage exactement les limites entre plusieurs instances de l’API. Les IP,
UUID et numéros ne sont jamais utilisés tels quels dans les clés : un HMAC-SHA-256 produit une clé
pseudonymisée. Le client désactive la file hors ligne, borne les reconnexions et impose un timeout court aux
commandes. Une indisponibilité retourne `503 rate_limit_unavailable` au lieu de désactiver silencieusement la
protection. Le Compose local n’active ni sauvegarde ni AOF, limite Redis à 128 Mio, utilise `noeviction` et ne
publie le port que sur la boucle locale. `ENV=production` impose en plus TLS et un mot de passe.

## 23. Santé, OpenAPI et observabilité

### Santé

- `GET /health/live` : processus disponible ;
- `GET /health/ready` : vérification PostgreSQL, Scylla lorsqu’elle est activée et Redis lorsqu’il protège l’API ; `503` si une dépendance requise est indisponible.

### OpenAPI

- Swagger UI : `/docs` ;
- JSON : `/docs-json` ;
- activé par défaut en développement/test ;
- désactivé par défaut en production ;
- DTO d’entrée et de réponse explicites pour auth, utilisateurs, consentements, matchs, messages, privacy, signalements, traits, plans et santé.

Un test d’intégration démarre le graphe Nest complet et génère réellement le document OpenAPI afin de détecter les imports de DTO ou métadonnées supprimés au runtime.

### Logs

- erreurs serveur avec stack côté serveur ;
- requêtes 4xx en warning ;
- requêtes 5xx en error ;
- request ID et durée ;
- logs du worker avec compteurs de lignes traitées.

Une plateforme de métriques/alertes n’est pas encore intégrée.

## 24. Tests

Tous les tests sont sous `test` :

```text
test/
├── unit/
├── e2e/
└── integration/
```

Inventaire actuel :

- 21 fichiers/suites unitaires, 112 cas ;
- 2 suites e2e, 9 cas ;
- 3 suites d’intégration, 28 cas dont 10 conditionnés par Scylla et 2 par Redis ;
- total complet : 26 fichiers/suites Jest et 149 cas.

Le 17 août 2026, TypeScript, ESLint et le build ont été validés localement. Sans infrastructure externe active, Jest a confirmé l’inventaire de 149 cas : 121 réussis et 28 ignorés dans les 3 suites d’intégration conditionnelles. Les tests exécutés couvrent notamment la sécurité du reset PostgreSQL, la configuration Sweego, les numéros français, les livraisons abandonnées et la concurrence OTP.

Le test de structure échoue si un futur fichier `.spec.*` ou `.test.*` est créé hors de `test`.

L’audit n’a détecté aucun test obsolète. Les tests proches ne sont pas des doublons inutiles : ils vérifient séparément le service, le contrat HTTP, la transaction repository ou PostgreSQL réel.

L’inventaire complet, test par test, les prérequis et les commandes se trouvent dans [`test.md`](test.md).

## 25. Validation locale

Le dépôt ne contient volontairement plus de workflow CI. La validation complète est exécutée localement dans cet ordre :

1. `pnpm install --frozen-lockfile` ;
2. `pnpm run db:migrate` sur une base vide ;
3. `pnpm run lint` ;
4. `pnpm run typecheck` ;
5. `pnpm run test:unit` ;
6. `pnpm run test:e2e` ;
7. `pnpm test` avec les trois intégrations obligatoires ;
8. smoke test manuel de la santé, de l’OTP réel, de l’idempotence, des jetons et du logout.

Pour cette mise à jour, le lint, le typecheck, le build et les 121 cas indépendants de l’infrastructure ont réussi le 17 août 2026 ; les 28 cas PostgreSQL, ScyllaDB et Redis ont été ignorés faute de services actifs. Une exécution des 149 cas avec ces trois dépendances reste requise avant livraison.

Les intégrations ciblent uniquement `histae-dev`, Redis DB 15 et les UUID Scylla temporaires documentés dans `test.md`.

## 26. Ce qui va particulièrement bien

- Le découpage controller/service/repository est cohérent et lisible.
- Les règles sensibles sont doublées entre application et PostgreSQL lorsque pertinent.
- Le modèle de consentement ne confond plus contrat, information et consentements facultatifs.
- La concurrence des consentements et des matchs est traitée transactionnellement.
- La concurrence des likes réciproques est absorbée par LWT Scylla et l’unicité transactionnelle PostgreSQL.
- L’effacement couvre réellement les tables de profil, de session et de personnalisation.
- L’export et l’effacement traversent désormais les deux bases sans annoncer un résultat partiel comme complet.
- La pagination évite les problèmes classiques d’offset et même la perte de précision des timestamps.
- Les migrations sont reproductibles et protégées contre les modifications silencieuses.
- L’exploitation possède maintenant health checks, shutdown propre et worker séparé.
- La validation locale couvre de vraies instances PostgreSQL, ScyllaDB et Redis.
- Le parcours OTP réel a été validé de bout en bout avec Sweego, idempotence et rotation des jetons.
- Les métadonnées d’injection Nest sont protégées par un test de non-régression dédié.

## 27. Limites et risques encore ouverts

### Bloquants fonctionnels

1. Aucun paiement/webhook : les plans sont lisibles mais non alimentés commercialement.

### Bloquants conformité/organisation

1. Validation juridique/DPO réelle encore nécessaire.
2. AIPD à décider et probablement à formaliser compte tenu de la géolocalisation et des données sensibles.
3. Politique des comptes inactifs non définie.
4. Politique de sauvegarde, purge dans les backups et restauration non documentée techniquement.
5. Sous-traitants et transferts à documenter.

### Bloquants exploitation

1. Remplacer le Redis Docker local par un Redis managé ou hautement disponible dans l’environnement cible.
2. Mettre en place métriques, dashboards et alertes.
3. Tester sauvegarde et restauration PostgreSQL.
4. Définir et tester sauvegarde/restauration, réparation et montée de version du cluster Scylla.
5. Ajouter tests de charge et dimensionnement du pool PostgreSQL, du cluster Scylla et du feed hybride.
6. Effectuer un audit de sécurité externe et des tests d’intrusion.
7. Mettre en place une rotation opérationnelle des clés/secrets.

### Couverture de test à étendre

- contrats HTTP complets hors auth ;
- concurrence du second consentement de continuation ;
- refresh token avec PostgreSQL réel ;
- retrait des consentements et effacement immédiat associé ;
- tombstone d’un compte banni ;
- pagination réelle des matchs et signalements ;
- maintenance sur un jeu de données expiré complet ;
- coupure réseau Redis réelle dans un environnement jetable ; le `503` et le partage inter-instances sont déjà couverts ;
- panne réseau Scylla réelle dans un environnement jetable, la panne simulée et son contrat HTTP étant déjà couverts ;
- suivi de livraison Sweego par webhook et paiements futurs.

## 28. Feuille de route recommandée

### Avant bêta interne

1. Valider le Sender ID Sweego, effectuer un envoi canari réel et ajouter le suivi de livraison opérationnel.
2. Ajouter les contrats HTTP e2e manquants.
3. Déployer Redis managé et l’ordonnanceur de maintenance dans l’environnement cible.
4. Ajouter métriques et alertes minimales.
5. Tester la restauration d’une sauvegarde.
6. Préparer un cluster Scylla jetable pour les essais de panne sans toucher au keyspace de développement.

### Avant bêta publique

1. Obtenir la validation juridique/DPO et finaliser l’AIPD.
2. Finaliser les textes et écrans mobiles avec les URL/version API.
3. Réaliser l’audit de sécurité externe.
4. Exécuter tests de charge et ajuster pool/timeouts.
5. Définir les comptes inactifs et les sauvegardes.

### Avant monétisation

1. Intégrer le fournisseur de paiement.
2. Vérifier la signature et l’idempotence des webhooks.
3. Modéliser remboursements, annulations et périodes de grâce.
4. Ajouter une réconciliation planifiée entre paiement et `user_subscription`.

### Découverte produit

1. Mesurer le taux d’exclusion Scylla, le nombre de lots PostgreSQL par page et les latences p50/p95/p99.
2. Ajouter anti-automatisation, détection de rafales et limites différenciées selon le plan si le produit le demande.
3. Décider si `pass` et `like` doivent avoir des TTL distincts après validation produit et juridique.
4. Ajouter éventuellement une table d’événements/outbox pour analytique, sans l’utiliser comme source de vérité du match.
5. Revoir l’algorithme de ranking au-delà de la distance seulement après disposer de métriques et de retours utilisateurs.

## 29. Commandes principales

```powershell
# Installation
pnpm install

# Migration
pnpm run db:migrate
docker compose -f docker-compose.scylla.yml up -d
$env:SCYLLA_ENABLED = 'true'
pnpm run scylla:migrate

# Effacement des seules données Scylla de développement
pnpm run db:reset-scylla

# Développement
pnpm run start:dev

# Qualité
pnpm run lint
pnpm run typecheck
pnpm run build

# Tests
pnpm run test:unit
pnpm run test:e2e
pnpm run test:integration

# Maintenance planifiée
$env:MAINTENANCE_MODE = 'worker'
pnpm run maintenance:run

# Reset destructif, uniquement en développement local
pnpm run db:reset
```

## 30. Documentation de référence

- [`README.md`](README.md) : installation, configuration et démarrage ;
- [`routes.md`](routes.md) : contrat détaillé des routes ;
- [`test.md`](test.md) : inventaire et rôle de chaque test ;
- [`docs/retention-policy.md`](docs/retention-policy.md) : matrice de conservation ;
- [`docs/legal-release-checklist.md`](docs/legal-release-checklist.md) : validation juridique avant production ;
- `/docs` et `/docs-json` : documentation OpenAPI générée lorsque celle-ci est activée.

## 31. Conclusion

Histae API possède désormais un socle backend sérieux : architecture modulaire, contraintes métier explicites,
concurrence transactionnelle, découverte hybride PostgreSQL/Scylla, modèle de consentement adapté au mobile,
effacement inter-bases, rétention automatisée, migrations reproductibles, pagination stable, documentation
OpenAPI et tests réels PostgreSQL.

Le principal risque n’est plus la structure interne du code, mais l’exploitation des briques externes : validation réelle du canal SMS, paiement, supervision, sauvegardes, audit de sécurité et validation juridique. La prochaine phase doit donc privilégier ces dépendances de production et étendre les contrats e2e, plutôt que réécrire le socle déjà en place.
