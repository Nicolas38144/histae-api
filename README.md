# Histae API

Backend TypeScript de l’application de rencontres Histae, construit avec NestJS 11 et Fastify 5.

Ce fichier sert uniquement à installer et exploiter le projet localement. Pour comprendre le métier, consulter
[resume.md](resume.md) ; pour le contrat HTTP, consulter [routes.md](routes.md).

## Architecture en bref

| Composant | Responsabilité | Choix local |
| --- | --- | --- |
| PostgreSQL | Source de vérité transactionnelle | Base `histae-dev` |
| ScyllaDB | Décisions de découverte à fort volume | Compose mono-nœud |
| Redis | Rate limiting distribué et relais SSE | Compose local |
| Stockage objet S3-compatible | Photos privées WebP | SeaweedFS `weed mini` |
| Analyse photo | Visage, netteté et score de contenu | Service FastAPI/OpenCV/ONNX optionnel |
| Sweego / FCM / Stripe | SMS OTP, push et facturation | Fournisseurs configurables |

L’API ne dépend d’aucune API propre à SeaweedFS. L’authentification administrateur est WebAuthn native, sans SSO.

## Prérequis

- Node.js 22 ou plus récent ;
- pnpm 11.22.0 ;
- PostgreSQL local ;
- Docker dans WSL pour ScyllaDB, Redis, SeaweedFS et, si souhaité, l’analyse photo.

Le gestionnaire de paquets est fixé dans `package.json` :

```powershell
corepack enable
corepack install
pnpm --version
```

## Installation locale

Depuis PowerShell :

```powershell
Copy-Item .env.example .env
pnpm install --frozen-lockfile
pnpm run db:migrate
```

Compléter `.env` sans jamais le commiter. `.env.example` est la référence exhaustive des variables et valeurs
locales. Les clés `PHONE_ENCRYPTION_KEY` et `PHONE_HASH_KEY` doivent chacune représenter exactement 32 octets.

Démarrer les dépendances depuis WSL :

```bash
docker compose -f docker-compose.scylla.yml up -d
docker compose -f docker-compose-redis.yaml up -d
docker compose -f docker-compose.object-storage.yml up -d
PHOTO_MODERATION_TOKEN='change-me-with-at-least-32-bytes' \
  docker compose -f docker-compose.photo-moderation.yml up -d
```

Attendre les healthchecks, puis revenir dans PowerShell :

```powershell
pnpm run scylla:migrate
pnpm run start:dev
```

L’API écoute par défaut sur `http://localhost:8080` ; les routes métier sont sous `/api`.
SeaweedFS n’est exposé que sur `127.0.0.1:8333`. L’analyse photo locale écoute par défaut sur
`127.0.0.1:8090`.

### Dashboard administrateur

En développement, utiliser exactement `http://localhost:5173`, le RP ID `localhost` et le proxy Vite `/api`.
WebAuthn n’accepte pas `127.0.0.1` comme substitut de `localhost`.

Après promotion d’un compte en `admin` ou `superadmin`, créer son enrôlement initial :

```powershell
pnpm run admin:webauthn:bootstrap -- <uuid-du-compte>
```

Le jeton n’est affiché qu’une fois et expire après quinze minutes par défaut. Conserver ensuite au moins deux
passkeys, dont idéalement une clé physique de secours.

## Processus d’arrière-plan

`MAINTENANCE_MODE=api` convient au développement mono-instance : l’API exécute aussi l’outbox et la maintenance.

En production, utiliser `MAINTENANCE_MODE=disabled` sur les processus HTTP, maintenir au moins un worker
`MAINTENANCE_MODE=worker pnpm run outbox:work` et planifier
`MAINTENANCE_MODE=worker pnpm run maintenance:run`. Cette passe programme aussi la réconciliation Stripe ; le
worker outbox effectue les lectures fournisseur. API et workers doivent utiliser la même version de code.

## Commandes

| Commande | Usage |
| --- | --- |
| `pnpm run start:dev` | API avec rechargement automatique |
| `pnpm run build` / `start:prod` | Compiler / lancer le build |
| `pnpm run db:migrate` | Appliquer et vérifier les migrations PostgreSQL |
| `pnpm run db:reset` | Reconstruire la seule base locale protégée `histae-dev` |
| `pnpm run scylla:migrate` | Appliquer le schéma ScyllaDB |
| `pnpm run db:reset-scylla` | Réinitialiser le keyspace local protégé |
| `pnpm run admin:webauthn:bootstrap -- <uuid>` | Enrôler la première passkey admin |
| `pnpm run seed:swipes` | Générer des décisions de développement |
| `pnpm run fixtures:photos` | Régénérer les fixtures photo synthétiques |
| `pnpm run maintenance:run` | Exécuter une passe de maintenance |
| `pnpm run outbox:work` | Consommer l’outbox en continu |
| `pnpm run lint` / `typecheck` / `build` | Contrôles statiques |
| `pnpm test` / `test:integration` | Tests autonomes / avec stockages locaux |

Les resets refusent tout environnement autre que `development`, toute adresse non loopback et toute cible autre
que la base ou le keyspace local explicitement autorisé. Voir [test.md](test.md) avant une validation réelle.

## Contrat HTTP

L’API n’embarque ni OpenAPI ni Swagger. [routes.md](routes.md) constitue le contrat HTTP. Les erreurs publiques ont
toujours la forme :

```json
{
  "error": {
    "code": "stable_code",
    "message": "Human-readable message"
  }
}
```

En production, `TRUST_PROXY=true` est refusé : configurer précisément les IP ou CIDR des proxies approuvés.

## Documentation

| Document | Rôle |
| --- | --- |
| [resume.md](resume.md) | Architecture, capacités et invariants métier actuels |
| [routes.md](routes.md) | Contrat HTTP exhaustif |
| [test.md](test.md) | Commandes, prérequis, isolation et limites des tests |
| [docs/roadmap.md](docs/roadmap.md) | Travaux restant à réaliser |
| [docs/postgres-migrations.md](docs/postgres-migrations.md) | Baseline, checksums et reset PostgreSQL |
| [docs/module-responsibilities.md](docs/module-responsibilities.md) | Frontières de code et de transaction |
| [docs/mobile-sessions.md](docs/mobile-sessions.md) | Sessions mobiles et rotation JWT |
| [docs/sweego-delivery.md](docs/sweego-delivery.md) | États et callbacks OTP |
| [docs/durable-notifications.md](docs/durable-notifications.md) | Outbox, push et acquittement |
| [docs/account-erasure.md](docs/account-erasure.md) | Effacement reprenable |
| [docs/stripe-reconciliation.md](docs/stripe-reconciliation.md) | Réconciliation des abonnements et créations Customer incertaines |
| [docs/resilience-tests.md](docs/resilience-tests.md) | Concurrence et pannes contrôlées |
| [docs/sql-performance.md](docs/sql-performance.md) | Audit et exploitation des requêtes SQL |
| [docs/logging-policy.md](docs/logging-policy.md) | Format, minimisation, rétention et accès aux logs |
| [docs/retention-policy.md](docs/retention-policy.md) | Conservation technique à faire valider |
| [docs/legal-release-checklist.md](docs/legal-release-checklist.md) | Validation juridique avant production |

Les règles impératives pour toute modification sont dans [AGENTS.md](AGENTS.md).
