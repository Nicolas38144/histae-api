# Histae API

Backend TypeScript de l’application de rencontres Histae, construit avec NestJS 11 et Fastify 5.

Ce guide installe un environnement de développement complet sur une machine Debian neuve, sans WSL. Il a été
pensé pour Debian 12 ou 13 avec PostgreSQL sur l’hôte et les autres dépendances dans Docker. Ce n’est pas une
procédure de mise en production : les choix mono-nœud, HTTP local et fournisseurs désactivés sont réservés au
développement.

## Ce qui sera installé

| Composant | Exécution locale | Rôle |
| --- | --- | --- |
| Histae API | processus Node.js | API métier sous `/api` |
| PostgreSQL | service Debian | source de vérité transactionnelle |
| ScyllaDB | conteneur mono-nœud | décisions de découverte |
| Redis | conteneur | rate limiting distribué et relais SSE |
| SeaweedFS `weed mini` | conteneur | stockage objet S3-compatible des photos |
| Modération photo | conteneur optionnel | visage, netteté et contenu interdit |
| Prometheus, Alertmanager et Grafana | conteneurs optionnels | métriques, alertes et tableaux de bord |

L’API ne dépend d’aucune fonction propre à SeaweedFS. L’authentification du dashboard est un WebAuthn natif, sans
SSO ni fournisseur d’identité externe.

## 1. Préparer Debian

Installer les outils système et PostgreSQL :

```bash
sudo apt update
sudo apt install -y ca-certificates curl git openssl build-essential postgresql postgresql-client
sudo systemctl enable --now postgresql
```

Installer Docker Engine et le plugin Compose depuis le dépôt officiel Docker :

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

Les commandes suivantes utilisent Docker sans `sudo`. Cette facilité donne à l’utilisateur des privilèges
équivalents à `root` sur la machine ; l’omettre et préfixer les commandes Docker par `sudo` si ce niveau d’accès
n’est pas acceptable.

```bash
sudo usermod -aG docker "$USER"
newgrp docker
docker compose version
```

## 2. Installer Node.js 22 et pnpm

Installer Node.js avec `nvm`, puis activer la version de pnpm attendue par le dépôt :

```bash
curl -fsSLo /tmp/nvm-install.sh \
  https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.7/install.sh
bash /tmp/nvm-install.sh

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 22
nvm alias default 22

corepack enable
corepack prepare pnpm@11.22.0 --activate
node --version
pnpm --version
```

Le résultat doit indiquer Node.js 22 ou plus récent et pnpm 11.22.0.

## 3. Créer PostgreSQL

Créer un rôle dédié et saisir un mot de passe local fort lorsque PostgreSQL le demande :

```bash
sudo -u postgres createuser --pwprompt histae
sudo -u postgres createdb --owner=histae histae-dev
psql -h 127.0.0.1 -U histae -d histae-dev -W -c 'SELECT 1;'
```

Conserver ce mot de passe : il devra être reporté dans `POSTGRES_PASSWORD`.

## 4. Cloner et installer l’API

```bash
git clone https://github.com/Nicolas38144/histae-api.git
cd histae-api
pnpm install --frozen-lockfile
cp .env.example .env
chmod 600 .env
```

Ne jamais commiter `.env` ni le contenu de `.secrets/`.

## 5. Configurer `.env`

Ouvrir le fichier avec l’éditeur de son choix :

```bash
nano .env
```

Pour un premier démarrage local, renseigner au minimum :

| Variable | Valeur ou règle |
| --- | --- |
| `ENV` | `development` |
| `POSTGRES_HOST` | `127.0.0.1` |
| `POSTGRES_USER` | `histae` |
| `POSTGRES_PASSWORD` | mot de passe créé à l’étape 3 |
| `POSTGRES_DB` | `histae-dev` |
| `JWT_SECRET` | secret aléatoire d’au moins 32 octets |
| `PHONE_ENCRYPTION_KEY` | 32 octets représentés par 64 caractères hexadécimaux |
| `PHONE_HASH_KEY` | autre clé de 32 octets, distincte de la précédente |
| `SMS_PROVIDER` | `disabled` tant que Sweego n’est pas configuré |
| `PUSH_PROVIDER` | `disabled` tant que FCM n’est pas configuré |
| `BILLING_PROVIDER` | `disabled` tant que Stripe n’est pas configuré |
| `PHOTO_MODERATION_PROVIDER` | `local_http` si le conteneur de modération est lancé, sinon `disabled` |
| `PHOTO_MODERATION_TOKEN` | secret aléatoire d’au moins 32 octets si `local_http` est utilisé |
| `TRUST_PROXY` | `false` en accès direct local |

Générer une valeur de 32 octets sous forme hexadécimale avec :

```bash
openssl rand -hex 32
```

Exécuter la commande séparément pour `JWT_SECRET`, `PHONE_ENCRYPTION_KEY`, `PHONE_HASH_KEY` et
`PHOTO_MODERATION_TOKEN` : ces valeurs doivent être différentes. Les identifiants `OBJECT_STORAGE_*` de
`.env.example` conviennent uniquement au développement ; les remplacer ensemble dans `.env` avant tout usage sur
une machine partagée.

Avec `SMS_PROVIDER=disabled`, aucun OTP réel ne sera envoyé. Cette configuration permet de démarrer et de tester
l’API, pas d’utiliser le parcours mobile complet avec un téléphone.

## 6. Démarrer les dépendances locales

Depuis la racine de `histae-api` :

```bash
docker compose --env-file .env \
  -f docker-compose-redis.yaml \
  -f docker-compose.scylla.yml \
  -f docker-compose.object-storage.yml \
  up -d --wait
```

Si `PHOTO_MODERATION_PROVIDER=local_http`, ajouter son fichier à la même composition :

```bash
docker compose --env-file .env \
  -f docker-compose-redis.yaml \
  -f docker-compose.scylla.yml \
  -f docker-compose.object-storage.yml \
  -f docker-compose.photo-moderation.yml \
  up -d --build --wait
```

Contrôler l’état sans afficher les variables d’environnement :

```bash
docker compose --env-file .env \
  -f docker-compose-redis.yaml \
  -f docker-compose.scylla.yml \
  -f docker-compose.object-storage.yml \
  ps
```

Ajouter `-f docker-compose.photo-moderation.yml` avant `ps` si le modèle local fait partie de la composition.

Ces fichiers Compose sont destinés à une machine de développement de confiance. Ne publier aucun de leurs ports
sur Internet.

## 7. Initialiser les schémas et lancer l’API

```bash
pnpm run db:migrate
pnpm run scylla:migrate
pnpm run start:dev
```

L’API écoute par défaut sur `http://localhost:8080`. Dans un second terminal :

```bash
curl -fsS http://127.0.0.1:8080/health/live
curl -fsS http://127.0.0.1:8080/health/ready
```

`live` confirme que le processus répond. `ready` ne doit réussir que lorsque les dépendances obligatoires sont
joignables. Le contrat métier commence sous `/api`; les deux routes de santé sont les seules exceptions.

En développement mono-instance, `MAINTENANCE_MODE=api` fait aussi exécuter l’outbox et la maintenance par le
processus HTTP.

## 8. Connecter le dashboard administrateur

Le développement WebAuthn exige exactement :

```ini
ADMIN_WEBAUTHN_ORIGIN=http://localhost:5173
ADMIN_WEBAUTHN_RP_ID=localhost
```

Le navigateur doit ouvrir `http://localhost:5173`, jamais `http://127.0.0.1:5173`. Le dashboard relaie `/api` vers
l’API locale, ce qui préserve la même origine côté navigateur.

Après avoir promu un compte en `admin` ou `superadmin`, générer l’enrôlement initial depuis ce dépôt :

```bash
pnpm run admin:webauthn:bootstrap -- <uuid-du-compte-admin>
```

Le jeton de bootstrap est un secret à usage unique, affiché une seule fois et valable quinze minutes par défaut.

## 9. Activer la supervision locale (optionnel)

La pile de supervision utilise des secrets Docker basés sur des fichiers. Créer les deux fichiers avant le premier
`docker compose up` :

```bash
install -d -m 700 .secrets
openssl rand -hex 32 | tr -d '\n' > .secrets/histae_metrics_token
openssl rand -base64 32 | tr -d '\n' > .secrets/histae_grafana_admin_password
chmod 600 .secrets/histae_metrics_token .secrets/histae_grafana_admin_password
```

Dans `.env`, définir ensuite :

```ini
METRICS_ENABLED=true
METRICS_HOST=0.0.0.0
METRICS_PORT=9091
METRICS_TOKEN=<contenu exact de .secrets/histae_metrics_token>
```

Redémarrer l’API, puis lancer la pile :

```bash
docker compose --env-file .env -f docker-compose.observability.yml up -d --wait
docker compose --env-file .env -f docker-compose.observability.yml ps
```

Les interfaces restent liées à la boucle locale :

| Interface | URL | Accès |
| --- | --- | --- |
| Grafana | `http://localhost:3001` | utilisateur `histae-admin`, mot de passe du fichier secret |
| Prometheus | `http://localhost:9090` | local uniquement |
| Alertmanager | `http://localhost:9093` | local uniquement |

Le listener de métriques de l’API écoute sur le port 9091 et exige le bearer token. Il ne doit jamais passer dans
un tunnel public. Le diagnostic et les tests `promtool` sont détaillés dans
[docs/observability.md](docs/observability.md).

## 10. Valider l’installation

Les contrôles sans fournisseur externe :

```bash
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run test:unit
pnpm run test:e2e
pnpm test
```

Lorsque PostgreSQL, ScyllaDB, Redis et le stockage objet local sont prêts :

```bash
pnpm run test:integration
```

Lire [test.md](test.md) avant les tests réels : ils imposent des cibles locales précises et des règles
d’isolation.

## Utilisation quotidienne

| Commande | Usage |
| --- | --- |
| `pnpm run start:dev` | lancer l’API avec rechargement automatique |
| `pnpm run build` puis `pnpm run start:prod` | compiler et lancer le build local |
| `pnpm run db:migrate` | appliquer et vérifier les migrations PostgreSQL |
| `pnpm run scylla:migrate` | appliquer le schéma ScyllaDB |
| `pnpm run maintenance:run` | exécuter une passe de maintenance |
| `pnpm run outbox:work` | consommer l’outbox en continu |
| `pnpm run admin:webauthn:bootstrap -- <uuid>` | préparer la première passkey d’un administrateur |

Pour arrêter une dépendance sans effacer ses volumes :

```bash
docker compose --env-file .env \
  -f docker-compose-redis.yaml \
  -f docker-compose.scylla.yml \
  -f docker-compose.object-storage.yml \
  down
docker compose --env-file .env -f docker-compose.observability.yml down
```

Si le modèle local a été démarré, ajouter `-f docker-compose.photo-moderation.yml` avant `down` afin d’arrêter toute
la composition en une seule opération.

Ne pas ajouter `--volumes` sauf si la suppression des données de développement est volontaire.

## Avant une mise en production

Cette installation ne suffit pas pour la production. Il reste notamment à fournir un stockage S3 durable et
sauvegardé, une topologie de données haute disponibilité, HTTPS, des domaines WebAuthn définitifs, une politique de
pare-feu, des fournisseurs réels, des sauvegardes restaurées en exercice, la supervision privée et les validations
de sécurité, charge et conformité listées dans [docs/roadmap.md](docs/roadmap.md).

En production, `TRUST_PROXY=true` est refusé : configurer explicitement les IP ou CIDR des proxies approuvés.

## Références du projet

| Document | Rôle |
| --- | --- |
| [resume.md](resume.md) | architecture, capacités et invariants actuels |
| [routes.md](routes.md) | contrat HTTP exhaustif, sans OpenAPI ni Swagger |
| [test.md](test.md) | commandes, prérequis et isolation des tests |
| [docs/roadmap.md](docs/roadmap.md) | travaux encore ouverts |
| [docs/observability.md](docs/observability.md) | métriques, alertes, dashboard et runbooks |
| [docs/postgres-migrations.md](docs/postgres-migrations.md) | baseline, migrations et reset PostgreSQL |
| [docs/module-responsibilities.md](docs/module-responsibilities.md) | frontières de code et de transaction |
| [docs/logging-policy.md](docs/logging-policy.md) | minimisation et exploitation des logs |
| [docs/legal-release-checklist.md](docs/legal-release-checklist.md) | validations juridiques avant production |
| [AGENTS.md](AGENTS.md) | règles impératives pour modifier le dépôt |

Sources d’installation système : [Docker Engine sur Debian](https://docs.docker.com/engine/install/debian/),
[PostgreSQL sur Debian](https://www.postgresql.org/download/linux/debian/),
[nvm](https://github.com/nvm-sh/nvm) et [pnpm](https://pnpm.io/installation).
