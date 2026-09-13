# Conteneurisation et déploiement

Ce guide décrit l’image Histae API et les compositions Docker. Il sépare volontairement le développement local
d’un futur déploiement : le premier fournit PostgreSQL, Redis, SeaweedFS et la modération sur une machine ;
le second ne prétend pas transformer ces services mono-nœud en infrastructure de production.

## Fichiers et responsabilités

| Fichier | Responsabilité |
| --- | --- |
| `Dockerfile` | image de développement et image d’exécution multi-stage |
| `.dockerignore` | exclusion des secrets, sorties et fichiers inutiles du contexte de build |
| `compose.yaml` | API, migration PostgreSQL, worker outbox et tâche de maintenance |
| `compose.dev.yaml` | stockages locaux, code monté, ports loopback et endpoints Docker |
| `compose.production.yaml` | environnement strict, réseaux externes et absence de port hôte |
| `compose.observability-container.yaml` | raccordement de Prometheus au listener interne `api:9091` |

L’image finale contient les dépendances de production, le JavaScript compilé et les schémas SQL nécessaires aux
migrations. Elle ne contient ni `.env`, ni `.secrets`, ni sources TypeScript, ni tests. L’API, le worker et les
commandes d’exploitation utilisent tous cette même image.

## Développement complet

### Préparer les valeurs locales

Copier puis protéger la configuration :

```bash
cp .env.example .env
chmod 600 .env
```

Renseigner au minimum `POSTGRES_PASSWORD`, `JWT_SECRET`, `PHONE_ENCRYPTION_KEY`, `PHONE_HASH_KEY` et
`PHOTO_MODERATION_TOKEN`. Utiliser une sortie distincte de cette commande pour chaque secret :

```bash
openssl rand -hex 32
```

Les variables applicatives de `.env` restent adaptées aux commandes exécutées depuis l’hôte : PostgreSQL et Redis
utilisent donc des adresses loopback. `compose.dev.yaml` les remplace uniquement dans les conteneurs par les noms
de service `postgres` et `redis`.

### Démarrer

L’exemple publie PostgreSQL Docker sur le port 5433 pour éviter une installation PostgreSQL native qui écoute déjà
sur 5432. `POSTGRES_HOST_PORT` et `POSTGRES_PORT` doivent conserver la même valeur pour l’API et les tests exécutés
depuis l’hôte. Les conteneurs continuent d’utiliser `postgres:5432` sur le réseau interne.

Depuis la racine du dépôt :

```bash
docker compose --env-file .env \
  -f compose.yaml \
  -f compose.dev.yaml \
  up -d --build --wait
```

Cette commande :

1. attend le healthcheck PostgreSQL ;
2. exécute les migrations PostgreSQL dans le service `migrate` ;
3. ne démarre l’API et le worker outbox qu’après la réussite complète des migrations ;
4. attend que l’API réponde sur `/health/live`.

Le conteneur `migrate` terminé avec le code `0` est un état normal :

```bash
docker compose --env-file .env -f compose.yaml -f compose.dev.yaml ps --all
curl -fsS http://127.0.0.1:8080/health/live
curl -fsS http://127.0.0.1:8080/health/ready
```

Les ports de développement sont liés à `127.0.0.1`. PostgreSQL utilise un volume Docker persistant à l’emplacement
prévu par l’image PostgreSQL 18 ; retirer le conteneur n’efface donc pas la base.

### Développer et exploiter

Les sources et schémas sont montés séparément dans les conteneurs applicatifs et Nest recharge les changements.
`node_modules` reste fourni par l’image : un changement de dépendance ou de configuration de compilation exige
donc un rebuild. Afficher des logs ciblés :

```bash
docker compose --env-file .env -f compose.yaml -f compose.dev.yaml logs -f api outbox-worker
```

Relancer explicitement les migrations idempotentes :

```bash
docker compose --env-file .env -f compose.yaml -f compose.dev.yaml run --rm migrate
```

Exécuter une passe de maintenance bornée :

```bash
docker compose --env-file .env -f compose.yaml -f compose.dev.yaml \
  --profile jobs run --rm --no-deps maintenance
```

Créer le bootstrap de la première passkey administrateur :

```bash
docker compose --env-file .env -f compose.yaml -f compose.dev.yaml \
  exec api pnpm run admin:webauthn:bootstrap -- <uuid-du-compte-admin>
```

Le token affiché est à usage unique. Il ne doit être ni journalisé ni enregistré dans un fichier du dépôt.

### Arrêter ou reconstruire

```bash
docker compose --env-file .env -f compose.yaml -f compose.dev.yaml down
docker compose --env-file .env -f compose.yaml -f compose.dev.yaml build --pull
```

`down` conserve les volumes. Ne pas ajouter `--volumes` sauf si la suppression de toutes les données locales est
volontaire. Une ancienne base PostgreSQL installée directement sur l’hôte n’est ni importée ni supprimée par cette
composition.

## Nom du stockage objet et URLs signées

`OBJECT_STORAGE_ENDPOINT` vaut en développement :

```ini
OBJECT_STORAGE_ENDPOINT=http://storage.histae.localhost:8333
```

Le suffixe réservé `.localhost` résout vers loopback sur la machine du navigateur. Sur le réseau Docker,
`compose.dev.yaml` donne exactement le même nom comme alias au service SeaweedFS. L’API contacte donc SeaweedFS et
produit une URL signée portant un hôte que le dashboard peut lui aussi joindre.

Ne pas remplacer cette valeur par `http://object-storage:8333` : la signature serait valide dans Docker, mais l’URL
retournée serait inutilisable depuis un navigateur ou l’application mobile. En production, le endpoint doit être
un nom HTTPS stable, résolu de manière cohérente depuis les conteneurs et les clients autorisés.

## Supervision avec l’API conteneurisée

Créer les secrets décrits dans [observability.md](observability.md), puis démarrer la pile avec son override :

```bash
docker compose --env-file .env \
  -f docker-compose.observability.yml \
  -f compose.observability-container.yaml \
  up -d --wait
```

Prometheus rejoint alors `api:9091` sur le réseau privé `histae-backend`. Le port 9091 n’est pas publié sur l’hôte.
Le fichier d’origine sans override reste utilisable lorsque l’API tourne directement sur l’hôte.

## Construire l’image finale

```bash
docker build --pull --target production -t histae-api:local .
docker image inspect histae-api:local --format '{{.Config.User}} {{.Config.WorkingDir}}'
```

L’inspection doit retourner l’utilisateur `node` et `/app`. Pour un déploiement, étiqueter l’image avec une version
immuable ou, de préférence, la référencer par digest. Ne pas utiliser `latest` comme mécanisme de retour arrière.

## Déploiement mono-machine

La composition de production ne publie aucun port. Elle suppose deux réseaux Docker déjà contrôlés :

- `histae-backend`, partagé uniquement avec les stockages TLS et la supervision ;
- `histae-edge`, partagé uniquement avec l’API et le reverse proxy ou tunnel Cloudflare.

Les créer une fois si l’orchestrateur du tunnel ne les a pas déjà créés :

```bash
docker network create histae-backend
docker network create histae-edge
```

Créer `.env.production` avec `ENV=production`, `HISTAE_ENV_FILE=.env.production`, une image immuable dans
`HISTAE_API_IMAGE` et toutes les valeurs exigées par `ConfigService`. Les contrôles de production refusent notamment
PostgreSQL sans TLS, Redis sans TLS/mot de passe, un endpoint S3
HTTP, Sweego ou Stripe incomplets et un proxy globalement approuvé.

Valider sans afficher la configuration résolue :

```bash
docker compose --env-file .env.production \
  -f compose.yaml \
  -f compose.production.yaml \
  config --quiet
```

Puis déployer :

```bash
docker compose --env-file .env.production \
  -f compose.yaml \
  -f compose.production.yaml \
  up -d --wait
```

Le tunnel doit cibler `http://api:8080` depuis `histae-edge`. PostgreSQL, Redis, SeaweedFS et le listener
9091 ne doivent pas rejoindre ce réseau. Un tunnel ne remplace ni WebAuthn, ni les guards, ni la configuration
précise de `TRUST_PROXY`.

### Planifier la maintenance sans composant supplémentaire

Le service `maintenance` est volontairement une commande à exécution unique. Sur Debian, un timer `systemd` peut
l’appeler toutes les cinq minutes sans introduire de scheduler applicatif supplémentaire. Le service doit exécuter
depuis le dossier de déploiement :

```ini
[Service]
Type=oneshot
WorkingDirectory=/opt/histae-api
ExecStart=/usr/bin/docker compose --env-file .env.production -f compose.yaml -f compose.production.yaml --profile jobs run --rm --no-deps maintenance
```

Le timer associé peut utiliser `OnCalendar=*:0/5` et `Persistent=true`. Tester manuellement la commande, les logs et
les métriques de retard avant d’activer le timer.

## PostgreSQL : persistance, sauvegarde et mise à niveau

Le volume `histae-postgres-data` protège seulement contre la recréation d’un conteneur. Il ne protège pas contre
une panne de disque, une suppression de volume, une corruption, un chiffrement malveillant ou la perte de la
machine.

Avant toute production :

1. fixer les objectifs de perte et de reprise ;
2. sauvegarder vers un autre support ou une autre machine ;
3. chiffrer et contrôler l’accès aux sauvegardes ;
4. restaurer réellement dans un environnement isolé ;
5. ajouter l’archivage WAL/PITR si un simple dump périodique perdrait trop de données ;
6. tester toute montée de version majeure avec `pg_upgrade` ou export/restauration avant de changer l’image.

Ne jamais sauvegarder un volume PostgreSQL actif par une copie de fichiers arbitraire. Utiliser les outils
PostgreSQL prévus et conserver les preuves de restauration sans donnée personnelle dans les logs du dépôt.

## Limites restantes

Cette livraison fournit le packaging et l’orchestration, pas la haute disponibilité. Une seule machine demeure un
point de panne unique. La cible S3 durable, les sauvegardes PostgreSQL restaurées, la rotation réelle des
secrets, le canal d’alertes et les tests de charge/sécurité restent suivis dans [roadmap.md](roadmap.md).
