# Histae API

Backend de l’application Histae construit avec **NestJS 11**, **Fastify** et **TypeScript**.

L’API expose des routes JSON sous le préfixe `/api` et s’appuie sur :

- **PostgreSQL** pour les comptes, profils, consentements, matchs et données métier ;
- **ScyllaDB** pour les décisions de découverte ;
- **Redis** pour les limites de débit distribuées ;
- un **stockage objet compatible S3** pour les photos privées ;
- **Sweego** pour l’envoi des codes OTP par SMS.

## Prérequis

- Node.js 22 ou plus récent ;
- pnpm 11.22.0 ;
- PostgreSQL ;
- Docker dans WSL pour ScyllaDB, Redis et SeaweedFS en développement.

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
docker compose -f docker-compose.scylla.yml ps
docker compose -f docker-compose-redis.yaml ps
docker compose -f docker-compose.object-storage.yml ps
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
```

Revenez dans PowerShell pour préparer ScyllaDB et lancer l’API :

```powershell
pnpm run scylla:migrate
pnpm run start:dev
```

L’API écoute par défaut sur `http://localhost:8080/api`.

Le Compose objet exécute SeaweedFS `weed mini`, crée le bucket privé, vérifie `/healthz` toutes les dix secondes et n’expose l’API S3 que sur
`127.0.0.1:8333`. Le code applicatif utilise exclusivement le contrat S3 du SDK AWS v3 : un remplacement par un
autre stockage compatible ne demande que la modification des six variables `OBJECT_STORAGE_*`.

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

## Authentification OTP

L’authentification combine inscription et connexion : après validation du code OTP, l’API reconnecte le compte
associé au téléphone ou crée un compte `user` s’il n’existe pas encore.

La livraison réelle des SMS nécessite `SMS_PROVIDER=sweego` et les identifiants Sweego correspondants. Les
numéros acceptés utilisent actuellement le format français E.164, par exemple `+33612345678`.

## Commandes principales

| Commande | Description |
| --- | --- |
| `pnpm run start:dev` | Lance l’API en développement avec rechargement automatique. |
| `pnpm run build` | Compile l’application dans `dist/`. |
| `pnpm run start:prod` | Exécute le build de production. |
| `pnpm run db:migrate` | Applique la baseline PostgreSQL puis les migrations incrémentales, dont le cycle photo et son outbox. Une base ayant les 15 anciennes versions est reconnue sans rejouer le schéma. |
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
les rétentions générales et sert de filet de réconciliation aux photos abandonnées.

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
- [Check-up de sécurité du 2 septembre 2026](docs/security-checkup.md)
