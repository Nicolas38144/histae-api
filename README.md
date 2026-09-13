# Histae API

Backend TypeScript de l’application de rencontres Histae, construit avec NestJS 11 et Fastify 5.

Ce guide installe l’environnement de développement complet sur une Debian neuve. L’API, PostgreSQL,
Redis, SeaweedFS et la modération photo s’exécutent dans Docker. Aucun Node.js ni PostgreSQL installé sur l’hôte
n’est nécessaire pour lancer l’application.

Les choix mono-nœud, HTTP local et fournisseurs désactivés restent réservés au développement. Voir
[le guide de conteneurisation](docs/container-deployment.md) avant toute utilisation sur un serveur.

## Architecture locale

| Service | Rôle | Accès depuis l’hôte |
| --- | --- | --- |
| `api` | API HTTP Nest/Fastify | `127.0.0.1:8080` |
| `migrate` | migrations PostgreSQL | aucune ; se termine avec le code 0 |
| `outbox-worker` | effets externes et reprises durables | aucun |
| `postgres` | source de vérité transactionnelle | `127.0.0.1:${POSTGRES_HOST_PORT}` (`5433` dans `.env.example`) |
| `redis` | rate limiting distribué et SSE | `127.0.0.1:6379` |
| `object-storage` | photos privées S3-compatibles | `127.0.0.1:8333` |
| `photo-moderation` | visage, netteté et contenu interdit | `127.0.0.1:8090` |

Tous les services communiquent sur `histae-backend`. L’API ne dépend d’aucune fonction propre à SeaweedFS.

## 1. Installer Docker sur Debian

Installer les outils de base :

```bash
sudo apt update
sudo apt install -y ca-certificates curl git openssl
```

Ajouter le dépôt officiel Docker :

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run --rm hello-world
```

L’accès au groupe Docker équivaut à des privilèges élevés sur la machine. Si cela est accepté pour le compte de
développement :

```bash
sudo usermod -aG docker "$USER"
newgrp docker
docker compose version
```

Sinon, conserver le groupe actuel et préfixer les commandes Docker par `sudo`.

## 2. Cloner et configurer Histae

```bash
git clone https://github.com/Nicolas38144/histae-api.git
cd histae-api
cp .env.example .env
chmod 600 .env
nano .env
```

Définir au minimum :

| Variable | Valeur de développement |
| --- | --- |
| `ENV` | `development` |
| `POSTGRES_PASSWORD` | mot de passe local fort |
| `JWT_SECRET` | secret aléatoire d’au moins 32 octets |
| `PHONE_ENCRYPTION_KEY` | 32 octets sous forme de 64 caractères hexadécimaux |
| `PHONE_HASH_KEY` | autre clé hexadécimale de 32 octets |
| `PHOTO_MODERATION_PROVIDER` | `local_http` |
| `PHOTO_MODERATION_TOKEN` | secret aléatoire d’au moins 32 octets |
| `SMS_PROVIDER` | `disabled` tant que Sweego n’est pas configuré |
| `PUSH_PROVIDER` | `disabled` tant que FCM n’est pas configuré |
| `BILLING_PROVIDER` | `disabled` tant que Stripe n’est pas configuré |
| `TRUST_PROXY` | `false` pour un accès local direct |

Générer séparément chaque secret cryptographique :

```bash
openssl rand -hex 32
```

Ne jamais réutiliser une valeur entre JWT, chiffrement du téléphone, pseudonymisation, modération, PostgreSQL et
métriques. Ne jamais commiter `.env` ou `.secrets/`.

## 3. Démarrer toute la pile

```bash
docker compose --env-file .env \
  -f compose.yaml \
  -f compose.dev.yaml \
  up -d --build --wait
```

Le premier démarrage télécharge et construit les images, initialise un nouveau volume PostgreSQL, attend les
healthchecks, applique les migrations PostgreSQL puis démarre l’API et le worker outbox.

L’exemple publie PostgreSQL Docker sur le port 5433 afin de ne pas entrer en conflit avec une installation native
sur 5432. `POSTGRES_HOST_PORT` et `POSTGRES_PORT` doivent rester identiques pour les commandes lancées depuis
l’hôte. La base native existante n’est jamais importée ou supprimée automatiquement.

Vérifier l’état :

```bash
docker compose --env-file .env -f compose.yaml -f compose.dev.yaml ps --all
curl -fsS http://127.0.0.1:8080/health/live
curl -fsS http://127.0.0.1:8080/health/ready
```

`migrate` doit apparaître comme terminé avec le code `0`. Les routes métier commencent sous `/api`; les seules
exceptions sont `/health/live` et `/health/ready`.

## 4. Travailler avec la pile

Suivre les logs sans exposer les variables d’environnement :

```bash
docker compose --env-file .env -f compose.yaml -f compose.dev.yaml logs -f api outbox-worker
```

Les dossiers `src/`, `scripts/` et `db/` sont montés de façon ciblée ; `start:dev` recharge les sources
sans masquer les dépendances de l’image. Après une modification des dépendances, du Dockerfile ou de la
configuration TypeScript :

```bash
docker compose --env-file .env -f compose.yaml -f compose.dev.yaml up -d --build --wait
```

Exécuter manuellement une passe de maintenance :

```bash
docker compose --env-file .env -f compose.yaml -f compose.dev.yaml \
  --profile jobs run --rm --no-deps maintenance
```

Relancer les migrations idempotentes :

```bash
docker compose --env-file .env -f compose.yaml -f compose.dev.yaml run --rm migrate
```

Arrêter les conteneurs sans effacer les données :

```bash
docker compose --env-file .env -f compose.yaml -f compose.dev.yaml down
```

Ne pas ajouter `--volumes` sauf si la suppression de PostgreSQL et SeaweedFS est
volontaire.

## Dashboard et WebAuthn

Le dashboard reste un dépôt séparé. En développement, utiliser exactement :

```ini
ADMIN_WEBAUTHN_ORIGIN=http://localhost:5173
ADMIN_WEBAUTHN_RP_ID=localhost
```

Ouvrir `http://localhost:5173`, jamais `http://127.0.0.1:5173`. Après promotion d’un compte en `admin` ou
`superadmin`, générer son bootstrap depuis le conteneur :

```bash
docker compose --env-file .env -f compose.yaml -f compose.dev.yaml \
  exec api pnpm run admin:webauthn:bootstrap -- <uuid-du-compte-admin>
```

Le token n’est affiché qu’une fois et expire après quinze minutes par défaut.

Les URLs signées de développement utilisent `storage.histae.localhost:8333`. Ce nom pointe vers SeaweedFS aussi
bien depuis Docker que depuis le navigateur, tout en conservant une seule variable `OBJECT_STORAGE_ENDPOINT`.

## Supervision locale

Créer les deux secrets fichiers :

```bash
install -d -m 700 .secrets
openssl rand -hex 32 | tr -d '\n' > .secrets/histae_metrics_token
openssl rand -base64 32 | tr -d '\n' > .secrets/histae_grafana_admin_password
chmod 600 .secrets/histae_metrics_token .secrets/histae_grafana_admin_password
```

Définir dans `.env` :

```ini
METRICS_ENABLED=true
METRICS_TOKEN=<contenu exact de .secrets/histae_metrics_token>
```

Recréer le service API, puis démarrer l’observabilité raccordée au réseau Docker :

```bash
docker compose --env-file .env -f compose.yaml -f compose.dev.yaml up -d api
docker compose --env-file .env \
  -f docker-compose.observability.yml \
  -f compose.observability-container.yaml \
  up -d --wait
```

Grafana est disponible sur `http://localhost:3001`, Prometheus sur `http://localhost:9090` et Alertmanager sur
`http://localhost:9093`. Le port métrique 9091 reste uniquement sur le réseau Docker et exige son bearer token.
Voir [docs/observability.md](docs/observability.md).

## Validation du code

L’exécution de la pile ne nécessite pas Node.js sur l’hôte. Pour contribuer et lancer toutes les validations,
installer Node.js 22 et pnpm 11.22.0 comme indiqué dans [test.md](test.md), puis :

```bash
pnpm install --frozen-lockfile
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run build:container
pnpm test
pnpm run test:integration
```

Les intégrations utilisent les ports loopback publiés par `compose.dev.yaml` et leurs propres schémas/identifiants.

## Production

Construire l’image finale :

```bash
docker build --pull --target production -t histae-api:local .
```

`compose.production.yaml` ne contient volontairement ni PostgreSQL mono-nœud ni port publié. Il attend des réseaux
externes, des stockages durables/TLS et toute la configuration stricte de production. Le tunnel ou reverse proxy ne
rejoint que `histae-edge` et cible `http://api:8080`; les données restent sur `histae-backend`.

Cette composition facilite un déploiement reproductible sur une machine, mais n’apporte aucune haute disponibilité.
Les sauvegardes hors machine, restaurations, montées de version, domaines WebAuthn, certificats, fournisseurs réels,
tests de charge et validations de sécurité restent obligatoires. La procédure complète et les limites sont dans
[docs/container-deployment.md](docs/container-deployment.md) et [docs/roadmap.md](docs/roadmap.md).

## Documentation

| Document | Rôle |
| --- | --- |
| [resume.md](resume.md) | architecture, capacités et invariants actuels |
| [routes.md](routes.md) | contrat HTTP exhaustif, sans OpenAPI ni Swagger |
| [test.md](test.md) | commandes, prérequis et isolation des tests |
| [docs/container-deployment.md](docs/container-deployment.md) | images, Compose, réseaux et exploitation |
| [docs/observability.md](docs/observability.md) | métriques, alertes, dashboard et runbooks |
| [docs/postgres-migrations.md](docs/postgres-migrations.md) | baseline, migrations et reset PostgreSQL |
| [docs/roadmap.md](docs/roadmap.md) | travaux encore ouverts |
| [AGENTS.md](AGENTS.md) | règles impératives pour modifier le dépôt |

Sources système : [Docker Engine sur Debian](https://docs.docker.com/engine/install/debian/),
[image PostgreSQL officielle](https://hub.docker.com/_/postgres) et
[bonnes pratiques de build Docker](https://docs.docker.com/build/building/best-practices/).
