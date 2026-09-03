# Histae API

Backend de l’application Histae construit avec **NestJS 11**, **Fastify** et **TypeScript**.

L’API expose des routes JSON sous le préfixe `/api` et s’appuie sur :

- **PostgreSQL** pour les comptes, profils, consentements, matchs et données métier ;
- **ScyllaDB** pour les décisions de découverte ;
- **Redis** pour les limites de débit distribuées ;
- un **stockage objet compatible S3** pour les photos privées ;
- **Sweego** pour l’envoi des codes OTP par SMS ;
- **WebAuthn natif** pour l’authentification forte du dashboard administrateur.

## Prérequis

- Node.js 22 ou plus récent ;
- pnpm 11.22.0 ;
- PostgreSQL ;
- Docker dans WSL pour ScyllaDB, Redis, SeaweedFS et l’analyse photo locale en développement.

Le gestionnaire de paquets est déclaré dans `package.json`. Corepack peut sélectionner automatiquement la bonne version :

```powershell
corepack enable
corepack install
pnpm --version
```

## Installation

Depuis PowerShell :

```powershell
Copy-Item .env.example .env
pnpm install --frozen-lockfile
pnpm run db:migrate
```

Complétez ensuite `.env`. Les variables indispensables incluent notamment la connexion PostgreSQL,
`JWT_SECRET`, `PHONE_ENCRYPTION_KEY` et `PHONE_HASH_KEY`. Les deux clés de téléphone doivent contenir exactement
32 octets, ou 64 caractères hexadécimaux. Ne commitez jamais ce fichier.

## Infrastructure locale

Depuis WSL :

```bash
cd histae-api
docker compose -f docker-compose.scylla.yml up -d
docker compose -f docker-compose-redis.yaml up -d
docker compose -f docker-compose.object-storage.yml up -d
PHOTO_MODERATION_TOKEN='change-me-with-at-least-32-bytes' docker compose -f docker-compose.photo-moderation.yml up -d
docker compose -f docker-compose.scylla.yml ps
docker compose -f docker-compose-redis.yaml ps
docker compose -f docker-compose.object-storage.yml ps
docker compose -f docker-compose.photo-moderation.yml ps
```

Attendez que ScyllaDB, Redis et SeaweedFS soient `healthy`, puis activez ScyllaDB dans `.env` :

```dotenv
SCYLLA_ENABLED=true
OBJECT_STORAGE_ENDPOINT=http://127.0.0.1:8333
OBJECT_STORAGE_REGION=us-east-1
OBJECT_STORAGE_BUCKET=histae-photos
OBJECT_STORAGE_ACCESS_KEY=histae-dev
OBJECT_STORAGE_SECRET_KEY=histae-dev-secret-change-me
OBJECT_STORAGE_FORCE_PATH_STYLE=true
PHOTO_MODERATION_PROVIDER=local_http
PHOTO_MODERATION_ENDPOINT=http://127.0.0.1:8090
PHOTO_MODERATION_TOKEN=change-me-with-at-least-32-bytes
ADMIN_WEBAUTHN_ORIGIN=http://localhost:5173
ADMIN_WEBAUTHN_RP_ID=localhost
```

Revenez dans PowerShell pour préparer ScyllaDB et lancer l’API :

```powershell
pnpm run scylla:migrate
pnpm run start:dev
```

L’API écoute par défaut sur `http://localhost:8080/api`.

En développement, le dashboard doit être ouvert avec **`http://localhost:5173`** et appeler l’API via son proxy
`/api`. WebAuthn autorise HTTP pour `localhost`, mais pas pour `127.0.0.1` ni pour un autre nom sans HTTPS. Après
avoir promu un compte existant au rôle `admin` ou `superadmin`, appliquez la migration puis générez son jeton
d’enrôlement temporaire :

```powershell
pnpm run admin:webauthn:bootstrap -- <uuid-du-compte-admin>
```

Le jeton n’est affiché qu’une fois, expire après quinze minutes par défaut et sert à enregistrer la première
passkey depuis l’écran de connexion du dashboard. Conservez ensuite au moins deux passkeys, idéalement dont une
clé de sécurité physique de secours.

Le Compose objet exécute SeaweedFS `weed mini`, crée le bucket privé, vérifie `/healthz` toutes les dix secondes et n’expose l’API S3 que sur
`127.0.0.1:8333`. Le code applicatif utilise exclusivement le contrat S3 du SDK AWS v3 : un remplacement par un
autre stockage compatible ne demande que la modification des six variables `OBJECT_STORAGE_*`.

Le Compose de modération lie sur `127.0.0.1:8090` un petit service CPU sans stockage persistant. Il combine un
classifieur NSFW ONNX, le détecteur de visages Haar d’OpenCV et un score de netteté par variance du Laplacien. Le
token partagé doit être identique dans Compose et dans `.env`. `PHOTO_MODERATION_PROVIDER=disabled` reste possible :
dans ce cas, ou si l’analyseur est indisponible, la photo est conservée privée et envoyée en revue manuelle.

Les photos de profil sont reçues via `multipart/form-data`. Seules les extensions `.jpg`, `.jpeg`, `.png`,
`.heic`, `.heif` et `.webp` sont acceptées. Le fichier reçu et le WebP privé enregistré sont chacun limités à
**500 000 octets**. L’API vérifie extension, type déclaré et signature, redimensionne au plus à 2 048 px,
retire les métadonnées, puis renvoie une URL signée valable cinq minutes.
L’upload est limité par défaut à dix tentatives par heure et par utilisateur.
Chaque `PUT /api/users/me/photo` exige aussi `Idempotency-Key: <UUID v4>`. Le client conserve la même clé pour
les retries d’une même requête ; pendant 24 heures, un upload terminé est rejoué sans nouvelle conversion ni
écriture objet, tandis qu’une réutilisation pour un autre fichier est refusée.

Chaque WebP reçoit une clé versionnée `profile-photos/<user_uuid>/<photo_uuid>.webp`. PostgreSQL conserve dans
`user_photo` son état (`pending`, `processing`, `ready` ou `deleting`), son type, sa taille, ses dimensions et son SHA-256,
mais jamais d’URL. Une activation atomique rend au plus une photo visible par profil. Si un appel S3 devient
incertain, la maintenance supprime ensuite l’objet orphelin. Les suppressions après remplacement ou demande
utilisateur sont inscrites dans une outbox PostgreSQL au sein de la transaction métier, puis exécutées de façon
asynchrone avec reprise exponentielle et dead-letter après dix tentatives.
La console admin expose des métriques de cycle de vie et une file de réconciliation paginée. Une relance manuelle
ne révèle ni clé objet ni image, refuse les photos saines et crée une trace d’audit avec son motif.
Les dead letters disposent également d’une file technique sans payload : une relance ou un abandon sûr exige une
authentification WebAuthn récente et produit un audit transactionnel. Une suppression photo ne peut pas être
abandonnée tant que sa ligne technique référence encore l’objet privé.

Les profils disposent aussi d’un catalogue de questions administrable. Chaque utilisateur peut enregistrer jusqu’à
trois réponses ordonnées via un remplacement atomique. Elles sont exposées sur son profil, dans la découverte et
les résumés de match, et figurent dans l’export RGPD. Le dashboard peut créer, modifier et supprimer une question ;
une suppression efface également toutes les réponses associées après confirmation explicite.

Une modération indépendante du cycle technique est créée à chaque nouvelle photo, bio ou réponse libre. Les textes
sans signal sont approuvés automatiquement ; les coordonnées personnelles, insultes, signaux sexuels ou de spam
restent privés jusqu’à décision humaine. Une photo n’est approuvée automatiquement que si l’analyse détecte
exactement un visage, une netteté suffisante et un score NSFW sous le seuil. Aucun contenu suspect n’est rejeté
automatiquement. Le dashboard possède une file centrale : la liste ne contient pas le texte ni la photo, l’ouverture
du détail exige un motif audité et la décision exige un motif. Une photo refusée passe immédiatement à `deleting`
et sa suppression objet est confiée à l’outbox.

## Authentification

L’application mobile combine inscription et connexion : après validation du code OTP, l’API reconnecte le compte
associé au téléphone ou crée un compte `user` s’il n’existe pas encore. Ces JWT mobiles ne sont jamais acceptés
par les routes administratives.

Chaque connexion mobile possède une famille de refresh tokens : leur rejeu révoque tous les descendants et
invalide les JWT associés. Les routes `/api/auth/sessions` et `/api/auth/logout-all` permettent de gérer les
connexions et leurs appareils push. Le mobile doit sérialiser les refresh, sans retry aveugle après perte de réponse.
La migration `010_mobile_refresh_sessions`, les contraintes de déploiement et la rotation HS256 via
`JWT_ACTIVE_KID` / `JWT_PREVIOUS_KEYS` sont décrites dans [`docs/mobile-sessions.md`](docs/mobile-sessions.md).

La livraison réelle des SMS nécessite `SMS_PROVIDER=sweego` et les identifiants Sweego correspondants. Les
numéros acceptés utilisent actuellement le format français E.164, par exemple `+33612345678`.

Le dashboard utilise exclusivement WebAuthn, sans SSO ni fournisseur d’identité externe. Les clés privées restent
dans l’authenticator. PostgreSQL ne conserve que la clé publique, le compteur, les challenges et secrets de session
hachés et les événements d’audit. La session est transmise par cookie `HttpOnly`, `SameSite=Strict`, avec expiration
inactive de 30 minutes et absolue de 8 heures par défaut. Toute mutation admin impose en plus l’origine WebAuthn
exacte. En production, l’origine doit être HTTPS et le cookie devient `Secure` avec le préfixe `__Host-`.
Chaque administrateur peut renommer ses passkeys, consulter ses sessions actives, révoquer une session précise et
parcourir un historique de sécurité paginé. Aucune de ces vues ne contient de secret de session ou de clé publique.

`GET /api/admin/metrics` fournit sans composant supplémentaire les compteurs et latences HTTP du processus, les
statuts sensibles, les résultats des appels aux dépendances configurées, le pool PostgreSQL, l’outbox et les
dernières exécutions de maintenance. Les métriques volatiles repartent à zéro au redémarrage ; les exécutions de
maintenance et l’état de l’outbox sont conservés dans PostgreSQL pour signaler un worker manquant ou en retard.

Les chemins SQL critiques (feed, matchs, recherche admin, exports et rétention) sont alignés avec des index dédiés
par la migration `009_sql_performance_indexes`. La méthode, les choix d’index et les plans locaux mesurés sont
documentés dans [`docs/sql-performance.md`](docs/sql-performance.md).

## Commandes principales

| Commande | Description |
| --- | --- |
| `pnpm run start:dev` | Lance l’API en développement avec rechargement automatique. |
| `pnpm run build` | Compile l’application dans `dist/`. |
| `pnpm run start:prod` | Exécute le build de production. |
| `pnpm run db:migrate` | Applique la baseline PostgreSQL puis les migrations incrémentales, dont le cycle photo, son outbox, la réconciliation, les questions de profil, la modération, WebAuthn administrateur, le suivi opérationnel et les index de performance SQL. Une base ayant les 15 anciennes versions est reconnue sans rejouer le schéma. |
| `pnpm run admin:webauthn:bootstrap -- <uuid>` | Crée pour un administrateur actif un jeton à usage unique permettant d’enregistrer sa première passkey. |
| `pnpm run scylla:migrate` | Applique les migrations ScyllaDB. |
| `pnpm run db:reset` | Reconstruit la base locale protégée `histae-dev`. |
| `pnpm run db:reset-scylla` | Vide les décisions de découverte du ScyllaDB local. |
| `pnpm run seed:swipes` | Génère les swipes de développement via l’API. |
| `pnpm run fixtures:photos` | Régénère les fixtures JPG, JPEG, PNG, WebP et la copie HEIF de test. |
| `pnpm run maintenance:run` | Exécute une passe de maintenance, y compris la réconciliation des objets photo. |
| `pnpm run outbox:work` | Consomme en continu l’outbox PostgreSQL avec `MAINTENANCE_MODE=worker`. |

Les commandes de réinitialisation refusent les environnements et cibles non locaux.

Avec `MAINTENANCE_MODE=api`, l’API consomme elle-même l’outbox, ce qui convient au développement mono-instance.
En production, utilisez `MAINTENANCE_MODE=disabled` sur les processus HTTP et déployez au moins un processus
`MAINTENANCE_MODE=worker pnpm run outbox:work`. La commande périodique `maintenance:run` reste nécessaire pour
les rétentions générales — y compris challenges, enrôlements, sessions et audits WebAuthn expirés — et sert de filet
de réconciliation aux photos abandonnées.

## Qualité et tests

```powershell
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run test:unit
pnpm run test:e2e
pnpm run test:integration
```

Les tests d’intégration nécessitent PostgreSQL, ScyllaDB et Redis locaux. La readiness et le smoke test photo
nécessitent en plus le stockage objet local. Les suites utilisent uniquement les cibles de développement autorisées
et nettoient leurs données temporaires.

## Contrat HTTP

L'API n'expose pas de document OpenAPI ni d'interface Swagger. Le contrat exhaustif et maintenu manuellement se trouve dans [`routes.md`](routes.md).

En production, `TRUST_PROXY=true` est refusé : les adresses IP ou réseaux CIDR des reverse proxies de confiance doivent être listés précisément.

Les erreurs de l’API conservent une structure stable :

```json
{
  "error": {
    "code": "stable_code",
    "message": "Human-readable message"
  }
}
```

## Documentation

- [Résumé technique et fonctionnel](resume.md)
- [Contrat exhaustif de l’API](routes.md)
- [Stratégie, inventaire et exécution des tests](test.md)
- [Check-up de sécurité du 3 septembre 2026](docs/security-checkup.md)
