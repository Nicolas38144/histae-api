# Tests de Histae API

Mise à jour : 16 août 2026.

## Organisation et règles

Tous les tests du projet sont regroupés dans le dossier `test` :

```text
test/
├── unit/          # règles métier et composants isolés, sans service externe
├── e2e/           # contrat HTTP Fastify avec dépendances contrôlées
└── integration/   # comportements réels PostgreSQL, ScyllaDB et Redis
```

Jest ne découvre que les fichiers `test/**/*.spec.ts`, grâce à `testRegex` dans `package.json`. Le test `test/unit/common/test-layout.spec.ts` parcourt en plus le dépôt et échoue si un fichier `.spec.*` ou `.test.*` est créé hors de `test`. Les dossiers générés ou externes `.git`, `dist` et `node_modules` sont ignorés.

État actuel : **24 fichiers de test, 24 suites Jest et 125 cas** lorsque Scylla et Redis sont activés :

- 90 tests unitaires ;
- 10 tests e2e ;
- 13 tests d’intégration PostgreSQL/OpenAPI ;
- 10 tests d’intégration hybride ScyllaDB/PostgreSQL ;
- 2 tests d’intégration Redis.

Jest affiche 19 suites unitaires, 2 suites e2e et 3 suites d’intégration. Chaque intégration réelle est ignorée sauf si son flag `REQUIRE_*_TESTS` vaut `true`. Avec uniquement `REQUIRE_POSTGRES_TESTS=true`, 113 cas sont exécutés et 12 ignorés ; sans aucun flag d’intégration, 100 cas sont exécutés et 25 ignorés. Les tests paramétrés couvrent notamment les environnements, les dates invalides et les 36 classes injectées Nest.

## Commandes

```powershell
# Tous les tests découverts par Jest. Les intégrations réelles restent
# désactivées tant que leurs flags REQUIRE_* ne sont pas positionnés.
pnpm test

# Tests isolés, sans PostgreSQL ni Redis.
pnpm run test:unit

# Contrats HTTP Fastify avec providers simulés.
pnpm run test:e2e

# Tests PostgreSQL/OpenAPI réels.
# Redis Docker doit être démarré car le graphe Nest complet vérifie sa connexion.
$env:REQUIRE_POSTGRES_TESTS = 'true'
$env:MAINTENANCE_MODE = 'disabled'
pnpm run test:integration

# Les 10 scénarios Scylla réels, avec PostgreSQL de développement.
$env:TEST_SCYLLA_KEYSPACE = 'histae_discovery'
$env:REQUIRE_SCYLLA_TESTS = 'true'
pnpm run test:integration:scylla

# Redis réel, exclusivement dans la base logique 15.
$env:TEST_REDIS_ADDR = '127.0.0.1:6379'
$env:TEST_REDIS_DB = '15'
$env:REQUIRE_REDIS_TESTS = 'true'
pnpm run test:integration:redis

# Mode interactif.
pnpm run test:watch
```

Les suites PostgreSQL et Scylla lisent directement la configuration PostgreSQL de `.env`. Lorsqu'elles sont
activées, elles refusent toute cible autre que `ENV=development` et `POSTGRES_DB=histae-dev`. Elles utilisent des
UUID aléatoires, annulent les scénarios transactionnels et nettoient précisément les autres données temporaires.
La suite Scylla utilise le keyspace `histae_discovery` sans `DROP`, `TRUNCATE` ou `ALTER TABLE`. La suite Redis
refuse toute base logique autre que 15 et ses compteurs uniques expirent automatiquement après deux secondes.

## Tests unitaires

### `test/unit/auth/auth.guard.spec.ts` — 4 tests

Suite `JwtActiveGuard legal onboarding enforcement` :

1. Vérifie qu’un utilisateur actif mais sans CGU et notice courantes reçoit `403 onboarding_incomplete`.
2. Vérifie qu’un utilisateur ayant accepté les versions attendues passe le guard et reçoit son contexte `request.auth`.
3. Vérifie que la gestion des choix juridiques, la déconnexion et la suppression de compte restent utilisables pendant l’onboarding.
4. Inspecte les métadonnées du décorateur et garantit que seules les routes strictement nécessaires sont exemptées ; la mise à jour du profil ne l’est pas.

### `test/unit/auth/auth.service.spec.ts` — 2 tests

Suite `AuthService development registration` :

1. Vérifie que l’inscription de développement crée toujours un rôle `user`, normalise le téléphone et ne permet pas à l’appelant de choisir un rôle privilégié.
2. Vérifie le secret du bootstrap superadmin et garantit qu’une tentative avec un mauvais secret n’appelle pas la création privilégiée.

### `test/unit/auth/token.service.spec.ts` — 2 tests

Suite `TokenService` :

1. Vérifie le format `jti:secret`, le hashage du refresh token, l’absence du secret dans la représentation persistée et la validation d’un token encore utilisable.
2. Vérifie que la signature des access tokens impose explicitement l’algorithme HS256.

### `test/unit/common/dto/api-validation.pipe.spec.ts` — 2 tests

Suite `ApiValidationPipe` :

1. Vérifie la transformation d’un JSON valide en instance de DTO.
2. Vérifie le refus des champs inconnus et des champs obligatoires absents avec le code d’erreur stable `invalid_request_body`.

### `test/unit/common/nest-metadata.spec.ts` — 36 tests paramétrés

Suite `Nest dependency metadata` : un cas est exécuté pour chacune des 36 classes injectées principales, y compris le nouveau service Redis partagé.

Chaque cas vérifie que `emitDecoratorMetadata` contient des tokens de constructeur réels et jamais `Function`, `Object` ou `undefined`. Ce test empêche la régression où un import `type` TypeScript supprimerait au runtime le token dont Nest a besoin pour l’injection de dépendances.

### `test/unit/common/pagination.spec.ts` — 2 tests

Suite `cursor pagination` :

1. Vérifie que la page coupe correctement `limit + 1`, produit un curseur opaque à partir de la dernière ligne visible et permet de le décoder.
2. Vérifie le rejet d’un curseur non JSON ou contenant un identifiant qui n’est pas un UUID, avec `400 invalid_cursor`.

### `test/unit/common/test-layout.spec.ts` — 1 test

Suite `test layout` : parcourt le dépôt et garantit que tous les fichiers correspondant aux conventions `.spec.*` et `.test.*` se trouvent sous `test`.

### `test/unit/config/config.service.spec.ts` — 7 tests paramétrés

Suite `parseEnvironment` :

- accepte séparément `development`, `test` et `production` ;
- refuse séparément `undefined`, la chaîne vide, `staging` et une valeur ambiguë telle que `developmentish`.

Cette suite vérifie que la configuration échoue fermement au lieu de choisir implicitement le mode développement.

### `test/unit/crypto/phone-crypto.spec.ts` — 2 tests

Suite `phone crypto` :

1. Vérifie le chiffrement AES-256-GCM, l’aléa du nonce, la taille du format chiffré et l’absence du numéro en clair.
2. Vérifie l’acceptation d’une clé brute de 32 octets ressemblant à de l’hexadécimal et le caractère déterministe du HMAC utilisé pour les recherches.

### `test/unit/discovery/discovery.service.spec.ts` — 4 tests

Suite `DiscoveryService` :

1. Vérifie l’exclusion des profils déjà swipés, l’arrondi public de distance et la précision exacte du curseur.
2. Vérifie qu’un match PostgreSQL n’est créé qu’après un like réciproque.
3. Refuse le remplacement d’une décision immuable avec `409 swipe_already_recorded`.
4. Échoue en mode fermé avec `503 discovery_unavailable` lorsque Scylla est désactivée.

### `test/unit/scripts/seed-fake-swipe.spec.ts` — 1 test

Suite `fake swipe seed planner` : garantit que les 400 utilisateurs déterministes reçoivent chacun exactement
20 cibles distinctes, soit 8 000 décisions composées de 4 000 likes et 4 000 passes. Elle vérifie également
que chaque paire contient exactement un like et un pass, ce qui interdit la création accidentelle d'un match.

### `test/unit/scripts/reset-scylla.spec.ts` — 2 tests

Suite `ScyllaDB reset safety` :

1. autorise uniquement la combinaison confirmée `development`, `histae_discovery` et contact point local ;
2. refuse avant connexion l'absence de confirmation, la production, Scylla désactivé, un autre keyspace, un hôte distant ou une liste d'hôtes vide.

### `test/unit/discovery/discovery.store.spec.ts` — 3 tests

Suite `DiscoveryStore` avec un client Scylla simulé :

1. Vérifie qu’un nouveau swipe utilise le TTL fixe du schéma, que les deux vues sont écrites et que chaque table utilise TWCS avec une fenêtre de 14 jours.
2. Vérifie qu’une réparation du miroir conserve l’échéance initiale au lieu de redonner un an de rétention.
3. Vérifie le bucketing déterministe des UUID dans 32 partitions et le refus d’une valeur invalide.

### `test/unit/matches/matches.repository.spec.ts` — 1 test

Suite `MatchesRepository maintenance` : vérifie l’ordre et les compteurs des trois phases de maintenance : `active` vers `awaiting_continuation`, expiration, puis purge physique.

### `test/unit/privacy/privacy.repository.spec.ts` — 1 test

Suite `PrivacyRepository maintenance` : vérifie les dix politiques de rétention, leur exécution par lots bornés, la suppression des positions après 24 heures, la conservation des preuves de consentement pendant cinq ans et celle des journaux d’accès pendant un an.

### `test/unit/privacy/privacy.service.spec.ts` — 2 tests

Suite `PrivacyService cross-database privacy operations` :

1. Vérifie que l’export portable combine PostgreSQL et uniquement les actions Scylla propres à l’utilisateur, sans exposer les décisions entrantes de tiers.
2. Vérifie que le traitement d’une demande d’effacement reçoit et exécute l’étape de suppression Scylla.

### `test/unit/ratelimit/rate-limit.service.spec.ts` — 3 tests

1. Vérifie le compteur Redis, le `429`, le `Retry-After` et l’absence de l’identifiant brut dans la clé HMAC.
2. Vérifie l’échec fermé `503 rate_limit_unavailable` lorsque Redis échoue.
3. Conserve le store mémoire uniquement comme repli explicite pour les environnements sans Redis.

### `test/unit/users/users.repository.spec.ts` — 2 tests

Suite `UsersRepository legal-choice ordering` :

1. Vérifie que les horodatages viennent de PostgreSQL, que le retrait utilise `clock_timestamp()` et que l’état courant est ordonné par `event_sequence`.
2. Vérifie l’idempotence d’un retry mobile identique : aucun nouvel événement n’est ajouté si le choix et la version sont déjà actifs.

### `test/unit/users/users.service.spec.ts` — 13 tests

Suite `UsersService consent enforcement` :

1. Refuse l’écriture du sexe sans consentement aux données sensibles.
2. Enregistre la version de chaque texte et renvoie l’état mobile enrichi : actions requises, version requise et URL du document.
3. Refuse une version juridique devenue obsolète.
4. Associe correctement les versions distinctes aux consentements sensible et de localisation.
5. Empêche de modéliser le retrait des CGU ou de l’accusé de présentation comme un simple retrait de consentement.
6. Ne déclare l’onboarding terminé qu’avec les versions courantes des deux documents obligatoires.
7 à 12. Refuse six dates calendaires invalides : jour inexistant, mois 13, mois 0, jour 0, format sans zéro initial et date-heure RFC3339 à la place de `YYYY-MM-DD`.
13. Vérifie que l’effacement des données de découverte Scylla précède l’anonymisation PostgreSQL.

## Tests e2e

### `test/e2e/auth.contract.spec.ts` — 5 tests

Cette suite démarre une vraie application Fastify de test avec `AuthController`, le filtre d’erreur global et des services maîtrisés :

1. Vérifie que `POST /api/auth/refresh` répond `200` avec la nouvelle paire de tokens.
2. Vérifie qu’un champ JSON inconnu est refusé avec l’enveloppe d’erreur stable.
3. Vérifie par HTTP qu’un rôle `superadmin` injecté dans l’inscription est refusé avant d’atteindre le service.
4. Vérifie le format stable `404 route_not_found` pour une route inconnue.
5. Vérifie l’existence, le statut `201`, l’en-tête secret et le payload de la route de bootstrap superadmin réservée au développement.

Le test métier d’inscription et le test HTTP ne sont pas des doublons obsolètes : le premier contrôle les arguments réellement envoyés au repository, le second contrôle la validation du contrat réseau.

### `test/e2e/discovery.contract.spec.ts` — 5 tests

Cette suite démarre Fastify avec le contrôleur de découverte et des dépendances contrôlées :

1. Vérifie `POST /api/swipes`, son statut `201`, son payload et son rate limit dédié.
2. Vérifie que le DTO refuse UUID et décision invalides avant le service.
3. Vérifie la conversion de `limit` et le transfert du curseur de `GET /api/feed`.
4. Vérifie l’enveloppe HTTP stable `503 discovery_unavailable` quand le service signale une panne Scylla.
5. Vérifie que l’ancienne route `POST /api/fake-match` répond désormais au format stable `404 route_not_found`.

## Tests d’intégration réels

### `test/integration/postgres.schema.integration.spec.ts` — 13 tests

La suite utilise un vrai pool PostgreSQL et le schéma effectivement migré :

1. **Tables requises** — vérifie l’existence des tables du contrat HTTP, des consentements, droits RGPD, blocages, notifications et tombstones.
2. **Index requis et nettoyage** — vérifie les index de recherche, purge et pagination, l’unicité d’un consentement actif, l’index de purge des refresh tokens par expiration et l’absence des neuf index redondants ou obsolètes supprimés par la migration `008`.
3. **Requêtes de rétention réelles** — exécute les dix requêtes contre PostgreSQL afin de détecter les erreurs SQL ou de typage que les mocks unitaires ne voient pas.
4. **Démarrage Nest et OpenAPI** — démarre le graphe applicatif complet, génère le document Swagger, vérifie les schémas de consentement, découverte, matchs, exports et signalements, ainsi que l’absence de `/fake-match`.
5. **Choix juridiques autorisés** — accepte exactement les quatre types supportés et confirme que `marketing` est rejeté par la base.
6. **Concurrence des consentements** — lance deux écritures concurrentes, vérifie leur ordre exact, une seule ligne active et la cohérence de `currentConsents`.
7. **Expiration arrivée à échéance** — confirme qu’un match en attente dont la fenêtre est dépassée devient `expired` avec purge à trente jours.
8. **Fenêtre encore ouverte** — confirme qu’un match futur reste `awaiting_continuation` et sans date de purge.
9. **Message après expiration** — confirme atomiquement le refus `expired`, la transition du match et l’absence totale d’insertion du message.
10. **Curseur à la microseconde** — insère trois messages dans la même milliseconde avec des microsecondes différentes et vérifie trois pages successives sans saut ni doublon.
11. **Éligibilité du feed** — exécute la requête PostgreSQL réelle, conserve le candidat compatible, exclut le blocage bilatéral, puis exclut un match existant.
12. **Blocage** — confirme qu’un blocage clôt le match existant, programme sa purge et empêche la création d’un nouveau match pour la paire.
13. **Effacement RGPD** — traite une demande d’effacement de `pending` à `in_progress`, puis `completed`; vérifie l’anonymisation du compte, la suppression du profil/préférences/position/blocages/état, le retrait des consentements, le masquage du message, la clôture du match et les journaux d’audit.

### `test/integration/scylla.discovery.integration.spec.ts` — 10 tests

Cette suite contacte le Scylla local réellement migré et `histae-dev`. Elle vérifie au démarrage l’existence des deux tables et leur TTL de production de 31 536 000 secondes :

1. crée réellement un `like` et un `pass` dans les deux vues orientées requêtes ;
2. confirme par LWT qu’une première décision est immuable et qu’un choix contradictoire reçoit `409` ;
3. lance deux likes réciproques simultanés et vérifie qu’un seul match existe dans PostgreSQL ;
4. crée 12 utilisateurs temporaires et confirme que le feed exclut le profil déjà swipé ;
5. compare décision et horodatage dans les vues par acteur et par cible ;
6. simule l’échec de la première écriture du miroir, puis confirme qu’un retry le répare avec le TTL restant ;
7. supprime un utilisateur impliqué dans une décision entrante et une décision sortante, puis contrôle les quatre références ;
8. confirme que l’export portable contient les propres décisions sortantes, jamais les décisions entrantes de tiers ;
9. écrit deux lignes de test avec un TTL de deux secondes et attend leur expiration effective sans modifier le TTL des tables ;
10. confirme que `DiscoveryService` transforme une indisponibilité Scylla en `503 discovery_unavailable`.

La suite ne coupe pas le conteneur Docker pendant l’exécution : le mapping HTTP du `503` est couvert séparément en e2e, afin de ne pas perturber le Scylla de développement.

### `test/integration/redis.integration.spec.ts` — 2 tests

Cette suite utilise le Redis Docker réel, exclusivement dans la base logique 15 :

1. vérifie `PING` à travers `RedisService`, donc le même chemin que la readiness ;
2. crée deux instances de `RateLimitService` et confirme qu’elles partagent atomiquement le même compteur et le même `429`.

## Procédure locale avant livraison

Les validations sont déclenchées manuellement. Avant une livraison :

1. démarrer Redis et Scylla avec les deux fichiers Compose ;
2. migrer `histae-dev` et Scylla ;
3. exécuter `pnpm run lint`, `pnpm run typecheck` et `pnpm run build` ;
4. exécuter `pnpm run test:unit` et `pnpm run test:e2e` ;
5. activer explicitement `REQUIRE_POSTGRES_TESTS`, `REQUIRE_SCYLLA_TESTS` et `REQUIRE_REDIS_TESTS` ;
6. exécuter `pnpm test` et vérifier que les 125 cas passent sans suite ignorée.

## Audit des tests obsolètes

L’audit du 16 août 2026 n’a identifié aucun test obsolète à supprimer :

- aucune suite ne cible les anciens noms de consentement ou un consentement marketing ;
- aucune suite n’attend l’ancien format libre de date de naissance ;
- aucune suite ne dépend de l’ancienne pagination uniquement par offset ;
- les tests de maintenance unitaires restent utiles pour l’ordre et les limites, tandis que l’intégration valide le SQL réel ;
- les tests d’inscription unitaires et HTTP couvrent deux frontières différentes ;
- le test de métadonnées Nest protège une panne runtime déjà détectée par les e2e.

Par conséquent, **aucun test valide n’a été supprimé artificiellement**. Supprimer les recouvrements mentionnés réduirait la capacité à localiser une régression entre DTO, service, repository et PostgreSQL.

## Couverture encore souhaitable

La suite actuelle est robuste sur les zones récemment refactorées, mais elle n’est pas exhaustive. Les prochains ajouts utiles sont :

- contrats HTTP complets des routes utilisateur, privacy, matches, traits et signalements ;
- tests de concurrence du second consentement de continuation et de consommation du quota Free ;
- scénarios complets de rotation/réutilisation frauduleuse d’un refresh token avec PostgreSQL ;
- tests du tombstone d’un compte banni et de son expiration ;
- tests de retrait des consentements sensible et de localisation avec effacement immédiat ;
- tests de pagination des matchs et signalements, en plus des messages ;
- tests du worker sur des lignes réellement expirées, pas seulement sur une base vide ;
- test d’une coupure réseau Redis réelle dans un environnement jetable, en complément de l’échec simulé déjà couvert ;
- test d’un arrêt réseau Scylla réel dans un environnement local jetable, sans interrompre le keyspace partagé ;
- tests du fournisseur SMS et des webhooks de paiement lorsqu’ils seront implémentés.
