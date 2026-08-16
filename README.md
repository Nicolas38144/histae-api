# Histae API

Backend de l’application mobile Histae construit avec **NestJS 11**, **TypeScript** et l’adaptateur **Fastify**. Il utilise PostgreSQL, ScyllaDB et Redis, avec le préfixe HTTP `/api`, des formats JSON et des codes d’erreur stables.

## Démarrage

Dans PowerShell :

```powershell
Copy-Item .env.example .env
pnpm install
pnpm run db:migrate
```

Dans le terminal WSL où Docker est disponible :

```bash
docker compose -f docker-compose.scylla.yml up -d
docker compose -f docker-compose-redis.yaml up -d
docker compose -f docker-compose.scylla.yml ps
docker compose -f docker-compose-redis.yaml ps
```

Quand les deux conteneurs sont `healthy`, placez `SCYLLA_ENABLED=true` dans `.env`, puis revenez dans PowerShell :

```powershell
pnpm run scylla:migrate
pnpm run start:dev
```

Les migrations sont versionnées, transactionnelles, protégées par verrou PostgreSQL et vérifiées par SHA-256. Redis est utilisé localement et en production pour partager les rate limits entre toutes les instances de l’API.

`ENV` est obligatoire (`development`, `test` ou `production`). Les comptes créés par `/api/auth/register` en développement sont toujours des comptes `user` : l’API ne permet jamais de choisir un rôle privilégié.

## Stockage et dépendances

`pnpm run db:migrate` applique dans l’ordre les migrations `001` à `008` et refuse qu’un fichier déjà appliqué ait changé de checksum. Les scripts manuels sont aussi disponibles : `db/schema_postgres.sql` crée le schéma complet, `db/insert_postgres.sql` ajoute les catalogues initiaux et `db/drop_postgres.sql` réinitialise la base.

Pour reconstruire entièrement une base de développement ou de test, utilisez `pnpm run db:reset`. La commande exécute ces trois scripts dans une transaction, recrée l'état des migrations et refuse toujours `ENV=production`. Elle exige une confirmation explicite :

```powershell
$env:CONFIRM_DB_RESET = 'RESET'
pnpm run db:reset
Remove-Item Env:CONFIRM_DB_RESET
```

Lorsque la cible est exactement `histae-dev` avec `ENV=development`, le reset ajoute aussi 400 faux utilisateurs
PostgreSQL complets : profil, préférences, localisation fraîche, choix juridiques, abonnement et traits. Leurs
téléphones factices ne permettent pas de s'authentifier. Ce seed
ne crée volontairement aucun swipe, car leurs décisions appartiennent à ScyllaDB ; utilisez le seed HTTP décrit
plus bas pour attribuer exactement 20 décisions de swipe à chacun de ces comptes.

La découverte utilise aussi ScyllaDB. Le schéma CQL est versionné dans `scylla/`, appliqué par
`pnpm run scylla:migrate` et vérifié par checksum. Le conteneur local épingle l’image
`scylladb/scylla:2026.2.2`. PostgreSQL reste la source des profils, consentements, préférences,
positions, blocages et matchs ; Scylla stocke les décisions de swipe dans deux tables orientées requêtes.
`GET /health/ready` vérifie PostgreSQL, Scylla lorsqu’elle est activée et Redis lorsqu’il assure la protection distribuée.

Pour vider toutes les décisions de swipe du Scylla local sans supprimer le keyspace, les tables ni le registre
des migrations, utilisez la commande protégée suivante. Elle refuse tout environnement autre que `development`,
tout keyspace autre que `histae_discovery` et tout contact point non local :

```powershell
$env:CONFIRM_SCYLLA_RESET = 'RESET_SCYLLA_DATA'
pnpm run db:reset-scylla
Remove-Item Env:CONFIRM_SCYLLA_RESET
```

Pour contrôler ou relancer l’infrastructure depuis WSL :

```bash
docker compose -f docker-compose.scylla.yml up -d
docker compose -f docker-compose-redis.yaml up -d
docker compose -f docker-compose.scylla.yml ps
docker compose -f docker-compose-redis.yaml ps
```

Le Redis Docker est volontairement éphémère : les compteurs de protection n’ont pas besoin d’être sauvegardés,
la mémoire est limitée à 128 Mio et `noeviction` force l’API à échouer fermement plutôt qu’à contourner une
limite. Le port n’est publié que sur `127.0.0.1`. En production, utilisez un Redis managé ou hautement
disponible avec TLS et mot de passe ; la configuration les impose. Le premier démarrage Scylla peut prendre
plusieurs dizaines de secondes.

## Peuplement HTTP des swipes de développement

`pnpm run seed:swipes` réutilise les 400 utilisateurs déterministes de `histae-dev`, rafraîchit leurs choix
juridiques et leur localisation, puis crée exactement 20 swipes distincts par utilisateur via l'API, soit
8 000 décisions dans ScyllaDB. La moitié sont des likes et l'autre moitié des passes. Il n'existe jamais deux
likes réciproques dans ce jeu de données : le script reste ainsi réexécutable et ne crée pas de faux matchs.
Hormis la lecture des identifiants du seed, chaque écriture passe par un endpoint de l'API.

Le serveur doit être démarré avec `ENV=development`, Scylla activée et des limites suffisamment élevées dans `.env` :

```dotenv
SCYLLA_ENABLED=true
RATE_LIMIT_GLOBAL=10000000
RATE_LIMIT_SWIPE=10000000
```

Exécutez d'abord `pnpm run db:reset` sur `histae-dev` pour créer les 400 profils. Dans un second terminal,
après le démarrage de l'API :

```powershell
$env:SEED_SWIPE_CONFIRM = 'CREATE_FAKE_SWIPES'
pnpm run seed:swipes
Remove-Item Env:SEED_SWIPE_CONFIRM
```

Options : `SEED_CONCURRENCY` (25) et `SEED_API_URL` (localhost:8080). Le script refuse tout environnement autre
que `development`, toute base autre que `histae-dev` et toute cible HTTP distante.

## Consentement et rétention

Après la vérification du téléphone, l'application enregistre séparément les choix juridiques de l'utilisateur
via `PUT /api/users/me/consents` : acceptation contractuelle des CGU, accusé de présentation de la politique
de confidentialité, consentement explicite aux données sensibles et consentement à la géolocalisation.
Histae ne réalise aucun traitement marketing et ne propose donc aucun consentement marketing.

Les quatre textes sont versionnés côté serveur avec `TERMS_OF_SERVICE_VERSION`, `PRIVACY_POLICY_VERSION`,
`SENSITIVE_DATA_CONSENT_VERSION` et `LOCATION_CONSENT_VERSION`, obligatoires en production. Le profil exige
les CGU et l'accusé de présentation ; les préférences ou le sexe exigent aussi le consentement aux données
sensibles. La géolocalisation est demandée séparément au moment de son activation. Une ancienne version est
traitée comme manquante et doit être présentée de nouveau à l'utilisateur.

Leurs URL absolues sont configurées avec `TERMS_OF_SERVICE_URL`, `PRIVACY_POLICY_URL`,
`SENSITIVE_DATA_CONSENT_URL` et `LOCATION_CONSENT_URL` (HTTPS obligatoire en production). L’état renvoyé au
mobile contient pour chaque choix la version requise et l’URL exacte à afficher.

Le guard d'authentification impose les CGU et la notice courantes à toutes les routes utilisateur protégées.
Pendant l'onboarding, seules la consultation et la mise à jour des choix juridiques, la déconnexion et la
suppression du compte restent accessibles. Les routes administrateur sont exemptées. L'endpoint
`GET|PUT /api/users/me/consents` renvoie aussi `onboarding_complete` et la liste `required_actions` destinée au mobile.

Le retrait du consentement sensible efface sexe et préférences ; celui de géolocalisation efface la présence.
La maintenance marque les positions obsolètes après une heure et applique les rétentions techniques : OTP et
refresh tokens expirés, notifications, consentements retirés (cinq ans), demandes RGPD traitées (cinq ans),
journaux d'accès (un an) et signalements résolus (trois ans). La matrice détaillée se trouve dans
[`docs/retention-policy.md`](docs/retention-policy.md). `LEGAL_REVIEW_REFERENCE` est obligatoire en production :
elle doit référencer une approbation réelle du juriste ou DPO, selon [`docs/legal-release-checklist.md`](docs/legal-release-checklist.md).

Les écritures concurrentes sont sérialisées par utilisateur, horodatées directement par PostgreSQL et ordonnées
par une séquence monotone. Une contrainte unique garantit un seul accord actif par type et les retries identiques
n'ajoutent pas de doublon au journal.

Les demandes d'accès, portabilité, rectification, restriction, opposition et effacement sont suivies dans
`data_subject_request`. Les exports et actions administrateur sont audités dans `data_access_log`. Le blocage
clôt les matchs et empêche leur recréation. L'effacement supprime les données de profil et de sécurité,
retire les consentements, masque les messages émis, efface les swipes dans les deux tables Scylla et programme
la purge des matchs sous 30 jours. L’export portable inclut uniquement les décisions prises par l’utilisateur ;
les choix entrants d’autres utilisateurs restent internes et ne sont utilisés que pour la réciprocité et l’effacement.

## Architecture

Chaque domaine suit le même découpage : `controller` (HTTP), `dto` (validation), `service` (règles métier), `repository` (PostgreSQL) et, lorsque nécessaire, `mapper` (réponse publique). Le domaine `discovery` ajoute un `store` Scylla. `RedisService` centralise la connexion, les compteurs atomiques et la readiness Redis. Les opérations de maintenance prennent des verrous PostgreSQL. En production, l'API utilise `MAINTENANCE_MODE=disabled` et un ordonnanceur exécute `MAINTENANCE_MODE=worker pnpm maintenance:run`; `api` reste pratique en développement.

La documentation OpenAPI est disponible sur `/docs` et `/docs-json` quand `OPENAPI_ENABLED=true`; elle est désactivée par défaut en production.

## Contrat HTTP préservé

- Authentification : `POST /api/auth/otp/send`, `/otp/verify`, `/refresh`, `/logout`, `/register` (développement seulement).
- Compte : `GET /api/users/me`, `PATCH /api/users/me/profile`, `/preferences`, `/presence`, `DELETE /api/users/me`.
- Vie privée : choix juridiques, demandes d'exercice des droits, export portable, blocages et journaux d'accès administrateur.
- Catalogue et traits : `GET /api/plans`, `GET /api/traits`, `POST|DELETE /api/users/me/traits`, `POST|PATCH|DELETE /api/admin/traits`.
- Modération : `POST /api/reports`, `GET|PATCH /api/admin/reports`.
- Matches : création automatique après deux likes réciproques, `GET /api/matches/me`, `GET /api/matches/:userId` (admin), `PATCH /api/matches/:id/reveal`, `/continue`.
- Messages : `GET|POST /api/matches/:id/messages`, `PATCH /api/matches/:id/messages/:msgId/read`.
- Découverte : `POST /api/swipes` enregistre un `like` ou `pass` dans Scylla et crée le match réciproque dans PostgreSQL ; `GET /api/feed` applique les critères mutuels PostgreSQL puis exclut dans Scylla les profils déjà swipés.

Les réponses d’erreur ont toujours cette forme :

```json
{ "error": { "code": "stable_code", "message": "Human-readable message" } }
```

## Points de compatibilité importants

- Les routes protégées vérifient le Bearer JWT, l’existence effective du compte et son statut de bannissement à chaque requête.
- Les rôles ne sont jamais inscrits dans le JWT ; le contrôle admin lit le rôle PostgreSQL courant.
- Les refresh tokens sont hashés, persistants et rotatifs avec verrouillage PostgreSQL.
- Les photos ne sont révélées qu’après deux consentements. Après 24 h, un match ouvre une seconde fenêtre de 24 h ; la continuation mutuelle consomme le quota Free de l’initiateur seulement au second consentement.
- Les listes de matchs, messages et signalements administrateur utilisent `next_cursor`; `offset` est conservé temporairement mais déprécié.

## Tests

Tous les tests sont regroupés hors du code applicatif dans `test/unit`, `test/e2e` et `test/integration`.
L’inventaire détaillé des 125 cas, leurs objectifs et leurs prérequis se trouve dans [`test.md`](test.md).

```powershell
pnpm run test:unit
pnpm run test:e2e
```

Le test d'intégration PostgreSQL est volontairement séparé. Il utilise exclusivement la base locale `histae-dev`
définie dans `.env`, crée des UUID temporaires et nettoie précisément ses données :

```powershell
$env:REQUIRE_POSTGRES_TESTS = 'true'
pnpm run test:integration
```

La suite Scylla réelle utilise des UUID temporaires dans `histae_discovery` et `histae-dev`, sans opération globale sur les tables :

```powershell
$env:TEST_SCYLLA_KEYSPACE = 'histae_discovery'
$env:REQUIRE_SCYLLA_TESTS = 'true'
pnpm run test:integration:scylla
```

La suite Redis utilise la base logique isolée 15 et vérifie le partage atomique d’un compteur entre deux instances applicatives :

```powershell
$env:TEST_REDIS_DB = '15'
$env:TEST_REDIS_ADDR = '127.0.0.1:6379'
$env:REQUIRE_REDIS_TESTS = 'true'
pnpm run test:integration:redis
```

Toutes les vérifications sont lancées localement. Les suites PostgreSQL et Scylla refusent une cible différente
de `ENV=development`, `POSTGRES_DB=histae-dev` et du keyspace `histae_discovery`.
