# Histae API

Backend de l’application Histae construit avec **NestJS 11**, **Fastify** et **TypeScript**.

L’API expose des routes JSON sous le préfixe `/api` et s’appuie sur :

- **PostgreSQL** pour les comptes, profils, consentements, matchs et données métier ;
- **ScyllaDB** pour les décisions de découverte ;
- **Redis** pour les limites de débit distribuées ;
- **Sweego** pour l’envoi des codes OTP par SMS.

## Prérequis

- Node.js 22 ou plus récent ;
- pnpm 11.22.0 ;
- PostgreSQL ;
- Docker dans WSL pour ScyllaDB et Redis.

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
docker compose -f docker-compose.scylla.yml ps
docker compose -f docker-compose-redis.yaml ps
```

Attendez que ScyllaDB et Redis soient `healthy`, puis activez ScyllaDB dans `.env` :

```dotenv
SCYLLA_ENABLED=true
```

Revenez dans PowerShell pour préparer ScyllaDB et lancer l’API :

```powershell
pnpm run scylla:migrate
pnpm run start:dev
```

L’API écoute par défaut sur `http://localhost:8080/api`.

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
| `pnpm run db:migrate` | Applique les migrations PostgreSQL. |
| `pnpm run scylla:migrate` | Applique les migrations ScyllaDB. |
| `pnpm run db:reset` | Reconstruit la base locale protégée `histae-dev`. |
| `pnpm run db:reset-scylla` | Vide les décisions de découverte du ScyllaDB local. |
| `pnpm run seed:swipes` | Génère les swipes de développement via l’API. |
| `pnpm run maintenance:run` | Exécute une passe de maintenance. |

Les commandes de réinitialisation refusent les environnements et cibles non locaux.

## Qualité et tests

```powershell
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run test:unit
pnpm run test:e2e
pnpm run test:integration
```

Les tests d’intégration nécessitent les services PostgreSQL, ScyllaDB et Redis locaux. Ils utilisent uniquement
les cibles de développement autorisées et nettoient leurs données temporaires.

## Documentation HTTP

Lorsque `OPENAPI_ENABLED=true`, Swagger est disponible sur :

- `http://localhost:8080/docs` ;
- `http://localhost:8080/docs-json`.

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
