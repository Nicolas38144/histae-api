# Histae API — état du projet

Mise à jour : 5 septembre 2026.

Ce document permet de reprendre rapidement le contexte technique et métier. Il ne duplique ni les routes
([routes.md](routes.md)), ni les procédures de test ([test.md](test.md)), ni le backlog
([docs/roadmap.md](docs/roadmap.md)).

## Capacités livrées

Histae API est un monolithe modulaire NestJS 11/Fastify 5 en TypeScript strict. Le socle courant comprend :

- authentification mobile OTP/JWT, familles de refresh et gestion des appareils ;
- authentification administrateur WebAuthn native et sessions serveur opaques ;
- onboarding, consentements, profil, préférences, traits et trois réponses guidées au maximum ;
- découverte ScyllaDB, swipes, match réciproque, continuation et messagerie ;
- abonnements Premium et projection Stripe ;
- blocages, signalements, modération des textes/photos et audit administratif ;
- photo privée unique, conversion WebP, stockage S3-compatible et suppression par outbox ;
- notifications durables par appareil, push optionnel et signaux SSE ;
- export, demandes RGPD et effacement reprenable ;
- healthchecks, métriques internes, maintenances et reprise auditée des dead letters.

Les travaux encore ouverts et leur ordre sont centralisés dans la roadmap.

## Architecture

### Technologies

| Zone | Choix |
| --- | --- |
| Runtime | Node.js 22+, pnpm 11.22.0, TypeScript strict |
| HTTP | NestJS 11, Fastify 5 |
| Données | PostgreSQL via `pg`, ScyllaDB via `cassandra-driver`, Redis |
| Photos | SDK AWS v3, Sharp, `heic-decode` |
| Admin | SimpleWebAuthn côté serveur |
| Fournisseurs | Sweego, Firebase Cloud Messaging, Stripe |
| Tests | Jest, contrats Fastify et intégrations réelles locales |

Le service local optionnel `services/photo-moderation` combine FastAPI, OpenCV et ONNX. Il n’est pas une source
de vérité et ne peut jamais rejeter automatiquement un contenu.

### Stockages

| Stockage | Données autorisées | À ne pas y placer |
| --- | --- | --- |
| PostgreSQL | Comptes, profils, consentements, abonnements, matchs, messages, audit, notifications et workflows | URL photo signée ou secret brut |
| ScyllaDB | Décisions de découverte sortantes et vues orientées cible | Profil ou donnée personnelle de référence |
| Redis | Compteurs de débit et relais SSE | État métier durable |
| S3-compatible | WebP privés sans métadonnées | URL publique persistée |

SeaweedFS `weed mini` est uniquement le choix local. Le code passe par `ObjectStorageService` et les six
variables `OBJECT_STORAGE_*`.

### Organisation du code

Les domaines sont dans `src/admin`, `admin-auth`, `auth`, `billing`, `discovery`, `matches`,
`mobile`, `moderation`, `outbox`, `photos`, `plans`, `privacy`, `profile-questions`, `reports`,
`traits` et `users`. Les briques partagées sont dans `common`, `config`, `crypto`, `database`,
`operations`, `ratelimit`, `redis`, `scylla` et `storage`.

La séparation attendue est : contrôleur pour HTTP, DTO pour l’entrée stricte, service pour le métier,
repository/store pour les accès aux données et mapper/model pour les représentations. Les frontières détaillées
sont dans [docs/module-responsibilities.md](docs/module-responsibilities.md).

## Sécurité et identité

### Mobile

Le téléphone français E.164 n’est jamais persisté ni journalisé en clair. Il est indexé par HMAC et chiffré par
AES-256-GCM. L’OTP est hashé, à usage unique et activé seulement après une confirmation Sweego exploitable.

Les access tokens sont des JWT HS256 typés `access`, liés à une famille par `sid` et signés avec un `kid`
local. Le rôle et l’état du compte sont relus dans PostgreSQL. Les refresh tokens sont rotatifs ; le rejeu d’un
ancêtre authentique révoque sa famille, tandis qu’un mauvais secret ne révoque rien. Voir
[docs/mobile-sessions.md](docs/mobile-sessions.md).

### Administration

Les JWT mobiles sont refusés sur toutes les routes administratives. Le dashboard utilise exclusivement WebAuthn :
origine et RP ID exacts, vérification utilisateur, passkey découvrable, challenge à usage unique et compteur
contrôlé. Les sessions sont opaques, hashées en base et transmises par cookie `HttpOnly; SameSite=Strict`.

Toute mutation vérifie l’origine. Les opérations sensibles exigent une authentification récente. En développement,
l’unique couple pris en charge est `http://localhost:5173` / `localhost` via le proxy Vite `/api`.
La production impose HTTPS et un cookie `__Host-…; Secure`.

### HTTP

Les DTO rejettent les champs inconnus. Les erreurs suivent `{ "error": { "code", "message" } }` sans stack.
Les réponses portent les en-têtes défensifs centralisés et un identifiant de requête. Les limites globales et
sensibles utilisent Redis en production et échouent fermement si la protection distribuée est indisponible.

Les logs ne contiennent ni message/stack d’exception, ni chemin HTTP concret, ni contenu, secret ou réponse
fournisseur. Ils utilisent des événements et codes normalisés ; rétention et accès sont définis dans
[docs/logging-policy.md](docs/logging-policy.md).

## Règles métier structurantes

### Consentements et profil

Les CGU et la notice courantes conditionnent les routes normales. Sexe et préférences nécessitent le consentement
aux données sensibles ; la présence exige celui de localisation. Les écritures verrouillent le compte et relisent
le consentement dans la même transaction que la mutation. Un retrait efface immédiatement les données concernées.

La date de naissance est un calendrier strict `YYYY-MM-DD` et l’utilisateur doit avoir au moins 18 ans.
Un profil conserve zéro à trois réponses ordonnées sur des questions distinctes, entre 10 et 300 caractères.
Supprimer une question efface ses réponses par cascade après confirmation dans le dashboard.

### Photos et modération

Une photo source doit être un JPG, JPEG, PNG, HEIC, HEIF ou WebP d’au plus 500 000 octets. Extension, MIME,
signature et dimensions sont vérifiés. Le résultat est un WebP privé sans métadonnées, lui aussi limité à
500 000 octets et stocké sous `profile-photos/<user_uuid>/<photo_uuid>.webp`.

`PUT /api/users/me/photo` exige une clé d’idempotence UUID v4 conservée 24 heures sous forme d’empreinte.
Le cycle inter-stockages reste réconciliable : PostgreSQL conserve les états, l’objet est écrit avant activation,
l’ancienne photo passe à `deleting` et `photo.delete` est émis dans la transaction métier.

Le statut technique et la modération sont indépendants. Seuls une photo `ready + approved`, une bio approuvée
et des réponses approuvées peuvent apparaître publiquement. L’automatisation approuve uniquement un contenu
clairement sûr ; tout signal ou échec passe en revue humaine. Les listes admin n’exposent ni contenu ni clé objet ;
le détail et la décision sont motivés et audités.

### Matchs et notifications

Une décision de swipe est immuable pendant sa rétention. Deux likes réciproques créent un seul match même en
concurrence. Échéances, continuation, quotas et messages idempotents restent atomiques sous verrou.

Notifications et tâches `notification.push` sont enregistrées dans la transaction métier. Le texte privé d’un
message ne va jamais dans FCM. Le push est au moins une fois : une réponse externe perdue peut produire un doublon,
dédupliqué par `notification_id`. SSE reste best-effort et sans replay.

### Facturation et effacement

Le client choisit uniquement une période mensuelle ou annuelle ; produits, prix, devise et essai viennent du
serveur. Les webhooks Stripe sont signés, dédupliqués et ordonnés avant projection.

L’effacement consomme un jeton dédié, désactive le compte et répond `202`. L’outbox reprend Stripe, photos,
Scylla puis PostgreSQL. Les checkpoints ne progressent qu’après effets confirmés ; `account.erase` ne peut
jamais être abandonné. Voir [docs/account-erasure.md](docs/account-erasure.md).

## Base de données et exploitation

`db/schema_postgres.sql` est la baseline PostgreSQL unique `001_baseline_20260904`. Les 44 tables définissent
leurs contraintes sans `ALTER TABLE`. Les index suivent leur table ; fonctions et triggers terminent le fichier.
La prochaine évolution persistante utilisera `015_<description>`. Voir
[docs/postgres-migrations.md](docs/postgres-migrations.md).

`/health/live` vérifie le processus ; `/health/ready` vérifie les dépendances configurées. L’outbox et la
maintenance peuvent tourner dans l’API en développement ou dans des workers séparés. Les métriques exposées au
dashboard sont agrégées, bornées et sans identifiant utilisateur.

Dernière validation complète : lint, typecheck, build, 553 tests autonomes et 185 intégrations locales, soit
738 tests dans 89 suites. Les résultats ne valent ni pentest, ni test de charge, ni validation d’un fournisseur réel.

## Références

- [README.md](README.md) : installation et commandes ;
- [routes.md](routes.md) : contrat HTTP ;
- [test.md](test.md) : validation et isolation ;
- [AGENTS.md](AGENTS.md) : règles impératives de modification ;
- [docs/roadmap.md](docs/roadmap.md) : travaux ouverts ;
- [docs/retention-policy.md](docs/retention-policy.md) et
  [docs/legal-release-checklist.md](docs/legal-release-checklist.md) : décisions à faire valider.
