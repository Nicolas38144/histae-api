# Tests de Histae API

Mise à jour : 21 août 2026.

## Organisation et règles

Tous les tests du projet sont regroupés dans le dossier `test` :

```text
test/
├── unit/          # règles métier et composants isolés, sans service externe
├── e2e/           # contrat HTTP Fastify avec dépendances contrôlées
└── integration/   # comportements réels PostgreSQL, ScyllaDB et Redis
```

Jest ne découvre que les fichiers `test/**/*.spec.ts`, grâce à `testRegex` dans `package.json`. Le test `test/unit/common/test-layout.spec.ts` parcourt en plus le dépôt et échoue si un fichier `.spec.*` ou `.test.*` est créé hors de `test`. Les dossiers générés ou externes `.git`, `dist` et `node_modules` sont ignorés.

Inventaire statique actuel : **28 fichiers de test, 28 suites Jest et 164 cas** lorsque toutes les intégrations sont activées :

- 126 tests unitaires ;
- 9 tests e2e ;
- 17 tests d’intégration PostgreSQL/OpenAPI ;
- 10 tests d’intégration hybride ScyllaDB/PostgreSQL ;
- 2 tests d’intégration Redis.

Jest affiche 23 suites unitaires, 2 suites e2e et 3 suites d’intégration. `pnpm test` exécute les 25 suites autonomes et leurs 135 cas ; `pnpm run test:integration` exécute directement les 3 suites réelles et leurs 29 cas, sans flag d’activation.

Le 21 août 2026, TypeScript, ESLint, le build et les 135 cas autonomes ont réussi. Les 17 intégrations PostgreSQL ont également réussi ; les suites ScyllaDB et Redis sont exécutées séparément lorsque leurs services sont démarrés.

## Commandes

```powershell
# Tous les tests autonomes, sans infrastructure externe.
pnpm test

# Tests isolés, sans PostgreSQL ni Redis.
pnpm run test:unit

# Contrats HTTP Fastify avec providers simulés.
pnpm run test:e2e

# Les 29 intégrations PostgreSQL, ScyllaDB et Redis réelles.
pnpm run test:integration

# Tests PostgreSQL/OpenAPI réels uniquement.
# Redis Docker doit être démarré car le graphe Nest complet vérifie sa connexion.
pnpm run test:integration:postgres

# Les 10 scénarios Scylla réels, avec PostgreSQL de développement.
pnpm run test:integration:scylla

# Redis réel, exclusivement dans la base logique 15.
pnpm run test:integration:redis

# Mode interactif.
pnpm run test:watch
```

Les suites PostgreSQL et Scylla lisent directement la configuration PostgreSQL de `.env`. Elles refusent toute
cible autre que `ENV=development` et `POSTGRES_DB=histae-dev`. Elles utilisent des
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

### `test/unit/auth/otp.service.spec.ts` — 9 tests

Suite `OtpService` :

1. Vérifie la normalisation du numéro, la génération cryptographique d’un code à six chiffres, sa persistance uniquement sous forme de HMAC, l’appel du transport SMS puis l’activation avec les identifiants fournisseur.
2. et 3. Rejouent séparément une clé déjà `sent` ou `pending` et garantissent qu’aucun second SMS n’est envoyé.
4. Rend une livraison fournisseur échouée inutilisable et la transforme en erreur stable `503 otp_delivery_unavailable`.
5. Transforme une livraison `pending` abandonnée et déjà classée `failed` en `503`, sans nouvel appel fournisseur.
6. Refuse un en-tête absent, une clé qui n’est pas un UUID v4 et une clé déjà liée à un autre numéro.
7. Vérifie la consommation du hash utilisable correspondant au numéro et au code.
8. et 9. Refusent un numéro étranger et un numéro français conservant le zéro national après `+33`.

### `test/unit/auth/sweego-sms.service.spec.ts` — 3 tests

Suite `SweegoSmsService` :

1. Vérifie le contrat transactionnel Sweego, l’en-tête `Api-Key`, le Sender ID, le destinataire, l’identifiant de campagne et l’absence de la clé secrète dans le corps.
2. Transforme les statuts non `200` et les réponses mal formées en erreurs fournisseur non sensibles, annule le corps HTTP en erreur et refuse notamment un tableau à la place de l’objet `swg_uids`.
3. Échoue fermement sans appel réseau lorsque le transport SMS est désactivé.

### `test/unit/auth/token.service.spec.ts` — 2 tests

Suite `TokenService` :

1. Vérifie le format `jti:secret`, le hashage du refresh token, l’absence du secret dans la représentation persistée et la validation d’un token encore utilisable.
2. Vérifie que la signature des access tokens impose explicitement l’algorithme HS256.

### `test/unit/common/dto/api-validation.pipe.spec.ts` — 2 tests

Suite `ApiValidationPipe` :

1. Vérifie la transformation d’un JSON valide en instance de DTO.
2. Vérifie le refus des champs inconnus et des champs obligatoires absents avec le code d’erreur stable `invalid_request_body`.

### `test/unit/common/nest-metadata.spec.ts` — 36 tests paramétrés

Suite `Nest dependency metadata` : un cas est exécuté pour chacune des 36 classes injectées principales, y compris le service Redis partagé.

Chaque cas vérifie que `emitDecoratorMetadata` contient des tokens de constructeur réels et jamais `Function`, `Object` ou `undefined`. Ce test empêche la régression où un import `type` TypeScript supprimerait au runtime le token dont Nest a besoin pour l’injection de dépendances.

### `test/unit/common/pagination.spec.ts` — 2 tests

Suite `cursor pagination` :

1. Vérifie que la page coupe correctement `limit + 1`, produit un curseur opaque à partir de la dernière ligne visible et permet de le décoder.
2. Vérifie le rejet d’un curseur non JSON ou contenant un identifiant qui n’est pas un UUID, avec `400 invalid_cursor`.

### `test/unit/common/test-layout.spec.ts` — 1 test

Suite `test layout` : parcourt le dépôt et garantit que tous les fichiers correspondant aux conventions `.spec.*` et `.test.*` se trouvent sous `test`.

### `test/unit/config/config.service.spec.ts` — 17 tests

Suite `parseEnvironment` :

- accepte séparément `development`, `test` et `production` ;
- refuse séparément `undefined`, la chaîne vide, `staging` et une valeur ambiguë telle que `developmentish`.

La section `ConfigService SMS configuration` ajoute dix cas : configuration Sweego française valide, fournisseur obligatoire en production, identifiants obligatoires, deux Sender ID invalides, URL non HTTPS, timeout supérieur à trente secondes, deux durées OTP hors limites et région autre que `FR`. La configuration échoue ainsi fermement au lieu de choisir implicitement un mode ou une valeur dangereuse.

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

1. autorise uniquement la combinaison `development`, `histae_discovery` et contact point local ;
2. refuse avant connexion la production, Scylla désactivé, un autre keyspace, un hôte distant ou une liste d'hôtes vide.

### `test/unit/scripts/reset-postgres.spec.ts` — 2 tests

Suite `PostgreSQL reset safety` :

1. autorise uniquement la combinaison `development`, `histae-dev` et hôte local ;
2. refuse avant connexion `test`, la production, une autre base ou un hôte distant.

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

### `test/e2e/auth.contract.spec.ts` — 4 tests

Cette suite démarre une vraie application Fastify de test avec `AuthController`, le filtre d’erreur global et des services maîtrisés :

1. Vérifie que `POST /api/auth/otp/send` accepte l’en-tête d’idempotence UUID v4, répond `202` et transmet la clé au service.
2. Vérifie que `POST /api/auth/refresh` répond `200` avec la nouvelle paire de tokens.
3. Vérifie qu’un champ JSON inconnu est refusé avec l’enveloppe d’erreur stable.
4. Vérifie le format stable `404 route_not_found` pour une route inconnue.

### `test/e2e/discovery.contract.spec.ts` — 5 tests

Cette suite démarre Fastify avec le contrôleur de découverte et des dépendances contrôlées :

1. Vérifie `POST /api/swipes`, son statut `201`, son payload et son rate limit dédié.
2. Vérifie que le DTO refuse UUID et décision invalides avant le service.
3. Vérifie la conversion de `limit` et le transfert du curseur de `GET /api/feed`.
4. Vérifie l’enveloppe HTTP stable `503 discovery_unavailable` quand le service signale une panne Scylla.
5. Vérifie que l’ancienne route `POST /api/fake-match` répond désormais au format stable `404 route_not_found`.

## Tests d’intégration réels

### `test/integration/postgres.schema.integration.spec.ts` — 17 tests

La suite utilise un vrai pool PostgreSQL et le schéma effectivement migré :

1. **Tables requises** — vérifie l’existence des tables du contrat HTTP, des consentements, droits RGPD, blocages, notifications et tombstones.
2. **Index requis et nettoyage** — vérifie les index de recherche, purge et pagination, les index OTP dont la contrainte unique d’un code utilisable, l’unicité d’un consentement actif, l’index de purge des refresh tokens par expiration et l’absence des dix index redondants ou obsolètes supprimés par les migrations `008` et `010`.
3. **Livraison OTP réelle** — confirme qu’un code devient utilisable seulement après acceptation fournisseur, qu’un retry de la clé n’insère rien et qu’un nouvel envoi échoué ne désactive pas le code précédent.
4. **Livraison abandonnée** — vieillit une ligne `pending`, rejoue sa clé et vérifie son passage à `failed` avec `delivery_unknown`.
5. **Concurrence OTP** — termine deux acceptations fournisseur simultanément et vérifie qu’un seul code reste `sent` et non utilisé.
6. **Requêtes de rétention réelles** — exécute les dix requêtes contre PostgreSQL afin de détecter les erreurs SQL ou de typage que les mocks unitaires ne voient pas.
7. **Démarrage Nest et OpenAPI** — démarre le graphe applicatif complet, génère le document Swagger, vérifie l’en-tête d’idempotence OTP, les schémas de consentement, découverte, matchs, exports et signalements, ainsi que l’absence de `/fake-match`.
8. **Choix juridiques autorisés** — accepte exactement les quatre types supportés et confirme que `marketing` est rejeté par la base.
9. **Concurrence des consentements** — lance deux écritures concurrentes, vérifie leur ordre exact, une seule ligne active et la cohérence de `currentConsents`.
10. **Expiration arrivée à échéance** — confirme qu’un match en attente dont la fenêtre est dépassée devient `expired` avec purge à trente jours.
11. **Fenêtre encore ouverte** — confirme qu’un match futur reste `awaiting_continuation` et sans date de purge.
12. **Message après expiration** — confirme atomiquement le refus `expired`, la transition du match et l’absence totale d’insertion du message.
13. **Curseur à la microseconde** — insère trois messages dans la même milliseconde avec des microsecondes différentes et vérifie trois pages successives sans saut ni doublon.
14. **Éligibilité du feed** — exécute la requête PostgreSQL réelle, conserve le candidat compatible, exclut le blocage bilatéral, puis exclut un match existant.
15. **Blocage** — confirme qu’un blocage clôt le match existant, programme sa purge et empêche la création d’un nouveau match pour la paire.
16. **Effacement RGPD** — traite une demande d’effacement de `pending` à `in_progress`, puis `completed`; vérifie l’anonymisation du compte, la suppression du profil/préférences/position/blocages/état, le retrait des consentements, le masquage du message, la clôture du match et les journaux d’audit.
17. **CA Premium estimé** — exécute l’agrégation administrateur réelle et vérifie que le nombre d’abonnements Premium multiplié par le tarif mensuel du catalogue produit le montant attendu.

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
5. exécuter `pnpm test` pour les 135 cas autonomes ;
6. exécuter `pnpm run test:integration` pour les 29 cas réels et vérifier que les 164 cas passent au total.

La validation du 21 août 2026 a réussi : **25 suites et 135 cas autonomes**, ainsi que les **17 cas PostgreSQL**.
Les 12 cas ScyllaDB et Redis sont conservés dans la campagne complète et ne sont pas affectés par cette évolution.
Un smoke test manuel complémentaire a validé la santé de l’API, l’envoi OTP Sweego réel, le retry idempotent sans
second SMS, la consommation du code, l’accès authentifié, la rotation du refresh token, le refus de l’ancien token
et le logout `204`.

## Audit des tests obsolètes

L’audit du 17 août 2026 n’a identifié aucun test obsolète à supprimer :

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
- tests d’un webhook de suivi de livraison Sweego, d’une perte de réponse fournisseur et des webhooks de paiement lorsqu’ils seront implémentés.
