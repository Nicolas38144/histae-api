# Histae API

Backend de l’application mobile Histae construit avec **NestJS 11**, **TypeScript** et l’adaptateur **Fastify**. Il utilise PostgreSQL, ScyllaDB et Redis, avec le préfixe HTTP `/api`, des formats JSON et des codes d’erreur stables.

## Démarrage

Le dépôt utilise exclusivement **pnpm 11.22.0** avec Node.js 22 ou plus récent. Corepack peut installer et
sélectionner automatiquement la version déclarée dans `package.json` :

```powershell
corepack enable
corepack install
pnpm --version
```

Dans PowerShell :

```powershell
Copy-Item .env.example .env
# Renseignez dans .env les valeurs laissées vides, notamment les trois clés cryptographiques.
pnpm install
pnpm run db:migrate
```

`.env.example` inventorie toutes les variables prises en charge sans contenir de secret réel. Après la copie,
renseignez au minimum `POSTGRES_PASSWORD`, `JWT_SECRET`, `PHONE_ENCRYPTION_KEY` et `PHONE_HASH_KEY` dans `.env` ;
les deux clés de téléphone doivent contenir exactement 32 octets (ou 64 caractères hexadécimaux).

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

`ENV` est obligatoire (`development`, `test` ou `production`). La vérification OTP crée un compte `user` lorsque le téléphone n’est pas encore connu ; l’API ne permet jamais au client de choisir un rôle privilégié.

## Livraison des OTP par SMS

La livraison réelle utilise l’API transactionnelle Sweego. En développement et en test, `SMS_PROVIDER` vaut
`disabled` par défaut ; en production, `SMS_PROVIDER=sweego` et les identifiants Sweego sont obligatoires.
Configurez les valeurs suivantes dans votre `.env` local, sans y placer de secret dans le dépôt :

```dotenv
SMS_PROVIDER=sweego
SWEEGO_API_KEY=
SWEEGO_API_URL=https://api.sweego.io/send
SWEEGO_SMS_SENDER_ID=Histae
SWEEGO_SMS_REGION=FR
SWEEGO_TIMEOUT=10s
OTP_TTL=10m
```

La livraison OTP est actuellement limitée aux numéros français au format `+33`; la région Sweego doit donc
rester `FR`. `POST /api/auth/otp/send` exige l’en-tête
`Idempotency-Key` contenant un UUID v4 neuf pour chaque demande logique. Un retry avec la même clé ne renvoie
pas un second SMS. Le code hashé devient utilisable uniquement après une réponse Sweego `200` valide ; une
livraison refusée ou ambiguë renvoie `503 otp_delivery_unavailable` et laisse le code inutilisable. Une demande
restée `pending` au-delà du timeout fournisseur et de cinq secondes de grâce devient `failed` lors de son prochain
retry. Un verrou PostgreSQL par téléphone et un index unique garantissent qu’un seul OTP envoyé reste utilisable.

## Stockage et dépendances

`pnpm run db:migrate` applique dans l’ordre les migrations `001` à `010` et refuse qu’un fichier déjà appliqué ait changé de checksum. Les scripts manuels sont aussi disponibles : `db/schema_postgres.sql` crée le schéma complet, `db/insert_postgres.sql` ajoute les catalogues initiaux et `db/drop_postgres.sql` réinitialise la base.

Pour reconstruire entièrement la base locale de développement, utilisez `pnpm run db:reset`. La commande
exécute ces trois scripts dans une transaction et recrée l'état des migrations. Elle exige simultanément
`ENV=development`, `POSTGRES_DB=histae-dev` et un hôte PostgreSQL local :

```powershell
pnpm run db:reset
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
pnpm run db:reset-scylla
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
pnpm run seed:swipes
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

- Authentification : `POST /api/auth/otp/send`, `/otp/verify`, `/refresh`, `/logout`.
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
L’inventaire détaillé des 149 cas, leurs objectifs et leurs prérequis se trouve dans [`test.md`](test.md).

```powershell
pnpm run test:unit
pnpm run test:e2e
pnpm test
```

Le test d'intégration PostgreSQL est volontairement séparé. Il utilise exclusivement la base locale `histae-dev`
définie dans `.env`, crée des UUID temporaires et nettoie précisément ses données :

```powershell
pnpm run test:integration:postgres
```

La suite Scylla réelle utilise des UUID temporaires dans `histae_discovery` et `histae-dev`, sans opération globale sur les tables :

```powershell
pnpm run test:integration:scylla
```

La suite Redis utilise la base logique isolée 15 et vérifie le partage atomique d’un compteur entre deux instances applicatives :

```powershell
pnpm run test:integration:redis
```

Les trois suites réelles peuvent être lancées ensemble avec `pnpm run test:integration`.

Toutes les vérifications sont lancées localement. Les suites PostgreSQL et Scylla refusent une cible différente
de `ENV=development`, `POSTGRES_DB=histae-dev` et du keyspace `histae_discovery`.

Validation du 17 août 2026 : le lint, le typecheck, le build et les 23 suites autonomes avec leurs 121 cas
réussissent. Les 3 suites et 28 cas PostgreSQL, ScyllaDB et Redis s’exécutent séparément ; l’inventaire complet
reste de 26 suites et 149 cas.
