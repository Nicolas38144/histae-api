# Tests de Histae API

Mise à jour : 23 août 2026.

## Organisation et règles

Tous les tests du projet sont regroupés dans le dossier `test` :

```text
test/
├── unit/          # règles métier et composants isolés, sans service externe
├── e2e/           # contrat HTTP Fastify avec dépendances contrôlées
└── integration/   # comportements réels PostgreSQL, ScyllaDB et Redis
```

Jest ne découvre que les fichiers `test/**/*.spec.ts`, grâce à `testRegex` dans `package.json`. Le test `test/unit/common/test-layout.spec.ts` parcourt en plus le dépôt et échoue si un fichier `.spec.*` ou `.test.*` est créé hors de `test`. Les dossiers générés ou externes `.git`, `dist` et `node_modules` sont ignorés.

Inventaire statique actuel : **39 fichiers de test, 39 suites Jest et 238 cas** lorsque toutes les intégrations sont activées :

- 181 tests unitaires ;
- 18 tests e2e ;
- 27 tests d’intégration PostgreSQL/OpenAPI ;
- 10 tests d’intégration hybride ScyllaDB/PostgreSQL ;
- 2 tests d’intégration Redis.

Jest affiche 32 suites unitaires, 4 suites e2e et 3 suites d’intégration. `pnpm test` exécute les 36 suites autonomes et leurs 199 cas ; `pnpm run test:integration` exécute directement les 3 suites réelles et leurs 39 cas, sans flag d’activation.

Le 23 août 2026, TypeScript, ESLint, le build et les 199 cas autonomes ont réussi. Les 39 intégrations réelles PostgreSQL, ScyllaDB et Redis ont également réussi.

## Commandes

```powershell
# Tous les tests autonomes, sans infrastructure externe.
pnpm test

# Tests isolés, sans PostgreSQL ni Redis.
pnpm run test:unit

# Contrats HTTP Fastify avec providers simulés.
pnpm run test:e2e

# Les 39 intégrations PostgreSQL, ScyllaDB et Redis réelles.
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

## Tester Stripe sans paiement réel

Les tests automatisés n’appellent jamais le réseau Stripe : le SDK est simulé pour Checkout/portail et utilisé
localement avec un secret factice pour vérifier cryptographiquement les signatures. Pour un test de bout en bout,
utiliser exclusivement une **sandbox Stripe** et ses clés `sk_test_*` : les cartes de test n’entraînent aucun débit réel.

1. Créer dans la sandbox le Product Premium et ses Prices mensuel/annuel.
2. Renseigner les variables Stripe de test dans `.env`, puis mettre `BILLING_PROVIDER=stripe`.
3. Installer Stripe CLI, se connecter, puis lancer :

```powershell
stripe listen --forward-to http://127.0.0.1:8080/api/billing/stripe/webhook
```

4. Copier le secret `whsec_*` affiché par cette commande dans `STRIPE_WEBHOOK_SECRET` pour cette session locale,
   redémarrer l’API, s’authentifier et appeler Checkout avec un nouvel UUID v4 :

```powershell
$headers = @{ Authorization = "Bearer <access_token>"; "Idempotency-Key" = "<uuid-v4>" }
$body = @{ billing_period = "monthly" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/api/users/me/subscription/checkout -Headers $headers -ContentType application/json -Body $body
```

5. Ouvrir l’URL retournée et utiliser `4242 4242 4242 4242`, une date future et un CVC quelconque.
6. Observer les événements forwardés, puis vérifier `GET /api/users/me/subscription`, le SSE et le portail.
7. Pour tester un renouvellement sans attendre, utiliser une Test Clock Stripe avec un Customer de sandbox et lier
   temporairement ce Customer à un utilisateur local dans `billing_customer`, ou terminer manuellement l’essai dans
   le Dashboard de test. Ne jamais faire cela avec une clé live ou une base partagée.

`stripe trigger` est utile pour tester que la route reçoit un événement signé, mais les fixtures génériques ne
portent pas forcément le Product, les Prices et les métadonnées Histae : le parcours Checkout réel de sandbox est
donc la référence pour valider les effets métier.

## Tests unitaires

### `test/unit/admin/admin.repository.spec.ts` — 3 tests

Vérifie la protection entre rôles administratifs, la révocation des sessions et l’audit lors d’un bannissement, ainsi que le calcul du revenu Premium estimé.

### `test/unit/admin/admin.service.spec.ts` — 6 tests

Vérifie le contrat public des listes, la validation et le mapping des actions administratives, la justification des accès aux conversations et le transfert des périodes de revenu.

### `test/unit/auth/auth.repository.spec.ts` — 2 tests

Suite `AuthRepository logout` :

1. Vérifie que la révocation du refresh token et la suppression de l’appareil demandé partagent la même transaction.
2. Vérifie qu’un token non révocable n’entraîne aucune suppression d’appareil.

### `test/unit/auth/auth.guard.spec.ts` — 5 tests

Suite `JwtActiveGuard legal onboarding enforcement` :

1. Refuse un JWT signé qui n’a pas le type `access` et vérifie aussi issuer, audience et algorithme.
2. Vérifie qu’un utilisateur actif mais sans CGU et notice courantes reçoit `403 onboarding_incomplete`.
3. Vérifie qu’un utilisateur ayant accepté les versions attendues passe le guard et reçoit son contexte `request.auth`.
4. Vérifie que la gestion des choix juridiques, la déconnexion et la suppression de compte restent utilisables pendant l’onboarding.
5. Inspecte les métadonnées du décorateur et garantit que seules les routes strictement nécessaires sont exemptées ; la mise à jour du profil ne l’est pas.

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

1. Vérifie le format `jti:secret`, le secret aléatoire de 256 bits, le hashage du refresh token, l’absence du secret dans la représentation persistée et la validation d’un token encore utilisable.
2. Vérifie que la signature des access tokens impose HS256, le type `access`, l’issuer `histae-api` et l’audience `histae-app`.

### `test/unit/common/dto/api-validation.pipe.spec.ts` — 2 tests

Suite `ApiValidationPipe` :

1. Vérifie la transformation d’un JSON valide en instance de DTO.
2. Vérifie le refus des champs inconnus et des champs obligatoires absents avec le code d’erreur stable `invalid_request_body`.

### `test/unit/common/nest-metadata.spec.ts` — 50 tests paramétrés

Suite `Nest dependency metadata` : un cas est exécuté pour chacune des 50 classes injectées principales, y compris Redis, le module mobile et les cinq composants Stripe Billing.

Chaque cas vérifie que `emitDecoratorMetadata` contient des tokens de constructeur réels et jamais `Function`, `Object` ou `undefined`. Ce test empêche la régression où un import `type` TypeScript supprimerait au runtime le token dont Nest a besoin pour l’injection de dépendances.

### `test/unit/common/pagination.spec.ts` — 2 tests

Suite `cursor pagination` :

1. Vérifie que la page coupe correctement `limit + 1`, produit un curseur opaque à partir de la dernière ligne visible et permet de le décoder.
2. Vérifie le rejet d’un curseur non JSON ou contenant un identifiant qui n’est pas un UUID, avec `400 invalid_cursor`.

### `test/unit/common/request-path.spec.ts` — 2 tests

Vérifie que les chemins sans query string restent inchangés et que les recherches ou justifications sensibles sont retirées avant journalisation.

### `test/unit/common/test-layout.spec.ts` — 1 test

Suite `test layout` : parcourt le dépôt et garantit que tous les fichiers correspondant aux conventions `.spec.*` et `.test.*` se trouvent sous `test`.

### `test/unit/config/config.service.spec.ts` — 33 tests

Suite `parseEnvironment` :

- accepte séparément `development`, `test` et `production` ;
- refuse séparément `undefined`, la chaîne vide, `staging` et une valeur ambiguë telle que `developmentish`.

Les autres cas couvrent la configuration Sweego, CORS, les limites des TTL OTP/JWT et du jeton de suppression, FCM et Stripe. Ils imposent aussi des clés cryptographiques distinctes, PostgreSQL TLS en production, les clés Stripe test/live selon l’environnement, les Product/Price IDs distincts, le secret `whsec_*`, les URL HTTPS et la conservation littérale de `{CHECKOUT_SESSION_ID}`.

### `test/unit/billing/billing.service.spec.ts` — 8 tests

1. Crée un Checkout mobile avec le Price choisi exclusivement côté serveur et le premier essai.
2. Rejoue une session persistée sans second appel Stripe.
3. Supprime le Customer Stripe nouvellement créé si sa liaison locale échoue.
4. Projette un webhook d’abonnement vérifié et émet `subscription.updated` une seule fois.
5. Récupère l’état courant lors d’un échec de facture, persiste la facture et programme la notification.
6. Acquitte un Event ID déjà traité sans nouvel appel réseau Stripe.
7. Refuse un webhook sans signature avant toute écriture.
8. Supprime le Customer Stripe pendant l’effacement du compte.

### `test/unit/billing/stripe.gateway.spec.ts` — 1 test

Signe un payload avec l’outil de test officiel du SDK Stripe, vérifie que les octets exacts sont acceptés et qu’un seul octet ajouté invalide la signature.

### `test/unit/crypto/phone-crypto.spec.ts` — 2 tests

Suite `phone crypto` :

1. Vérifie le chiffrement AES-256-GCM, l’aléa du nonce, la taille du format chiffré et l’absence du numéro en clair.
2. Vérifie l’acceptation d’une clé brute de 32 octets ressemblant à de l’hexadécimal et le caractère déterministe du HMAC utilisé pour les recherches.

### `test/unit/discovery/discovery.service.spec.ts` — 6 tests

Suite `DiscoveryService` :

1. et 2. Vérifient le statut de découverte incomplet puis prêt, avec la liste exacte des actions manquantes.
3. Vérifie l’exclusion des profils déjà swipés, l’arrondi public de distance et la précision exacte du curseur.
4. Vérifie qu’un match PostgreSQL n’est créé qu’après un like réciproque.
5. Refuse le remplacement d’une décision immuable avec `409 swipe_already_recorded`.
6. Échoue en mode fermé avec `503 discovery_unavailable` lorsque Scylla est désactivée.

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

### `test/unit/matches/matches.service.spec.ts` — 2 tests

Suite `MatchesService mobile messaging` :

1. Vérifie la normalisation de la clé d’idempotence et l’absence de seconde livraison lors du replay d’un message.
2. Vérifie le mapping stable `409 idempotency_key_conflict` lorsqu’une clé est réutilisée pour une autre requête.

### `test/unit/mobile/mobile.service.spec.ts` — 2 tests

1. Vérifie l’enregistrement normalisé d’un appareil et garantit que le jeton fournisseur ne sort jamais dans la réponse publique.
2. Vérifie l’erreur stable `404 device_not_found` pour un appareil inconnu de l’utilisateur.

### `test/unit/mobile/realtime.service.spec.ts` — 2 tests

1. Vérifie le filtrage strict des événements SSE par destinataire dans le repli mémoire.
2. Vérifie qu’un événement est publié une seule fois par destinataire distinct via Redis.

### `test/unit/mobile/push.service.spec.ts` — 1 test

Vérifie que le mode push désactivé ne charge aucun jeton et n’effectue aucun appel réseau.

### `test/unit/mobile/mobile-delivery.service.spec.ts` — 1 test

Vérifie qu’un événement de message atteint les deux participants en temps réel, que seul le destinataire reçoit la notification et qu’aucun contenu privé du message n’est persisté ni transmis à FCM.

### `test/unit/privacy/privacy.repository.spec.ts` — 1 test

Suite `PrivacyRepository maintenance` : vérifie les onze politiques de rétention, dont les jetons de suppression expirés, leur exécution par lots bornés, la suppression des positions après 24 heures, la conservation des preuves de consentement pendant cinq ans et celle des journaux d’accès pendant un an.

### `test/unit/privacy/privacy.service.spec.ts` — 3 tests

Suite `PrivacyService cross-database privacy operations` :

1. Vérifie que l’export portable combine PostgreSQL et uniquement les actions Scylla propres à l’utilisateur, sans exposer les décisions entrantes de tiers.
2. Vérifie que le traitement d’une demande d’effacement reçoit et exécute l’étape de suppression Scylla.
3. Vérifie l’ordre Stripe puis Scylla pour une demande d’effacement terminée par l’administration.

### `test/unit/ratelimit/rate-limit.service.spec.ts` — 3 tests

1. Vérifie le compteur Redis, le `429`, le `Retry-After` et l’absence de l’identifiant brut dans la clé HMAC.
2. Vérifie l’échec fermé `503 rate_limit_unavailable` lorsque Redis échoue.
3. Conserve le store mémoire uniquement comme repli explicite pour les environnements sans Redis.

### `test/unit/users/users.repository.spec.ts` — 2 tests

Suite `UsersRepository legal-choice ordering` :

1. Vérifie que les horodatages viennent de PostgreSQL, que le retrait utilise `clock_timestamp()` et que l’état courant est ordonné par `event_sequence`.
2. Vérifie l’idempotence d’un retry mobile identique : aucun nouvel événement n’est ajouté si le choix et la version sont déjà actifs.

### `test/unit/users/users.service.spec.ts` — 18 tests

Suite `UsersService consent enforcement` :

1. Refuse l’écriture du sexe sans consentement aux données sensibles.
2. Enregistre la version de chaque texte et renvoie l’état mobile enrichi : actions requises, version requise et URL du document.
3. Refuse une version juridique devenue obsolète.
4. Associe correctement les versions distinctes aux consentements sensible et de localisation.
5. Empêche de modéliser le retrait des CGU ou de l’accusé de présentation comme un simple retrait de consentement.
6. Ne déclare l’onboarding terminé qu’avec les versions courantes des deux documents obligatoires.
7 à 12. Refuse six dates calendaires invalides : jour inexistant, mois 13, mois 0, jour 0, format sans zéro initial et date-heure RFC3339 à la place de `YYYY-MM-DD`.
13. Refuse une URL photo HTTP non chiffrée avant toute persistance.
14. Vérifie que l’effacement des données de découverte Scylla précède l’anonymisation PostgreSQL.
15. Vérifie l’ordre Stripe supprimé → Scylla effacée → PostgreSQL anonymisé.
16. Vérifie le format, l’échéance et le hashage d’un jeton de suppression nouvellement émis.
17. Vérifie l’ordre jeton consommé → Scylla effacée → PostgreSQL anonymisé.
18. Refuse un jeton mal formé sans toucher aux données du compte.

## Tests e2e

### `test/e2e/auth.contract.spec.ts` — 6 tests

Cette suite démarre une vraie application Fastify de test avec `AuthController`, le filtre d’erreur global et des services maîtrisés :

1. Vérifie le bootstrap utilisateur `GET /api/auth/me`.
2. Vérifie que `POST /api/auth/otp/send` accepte l’en-tête d’idempotence UUID v4, répond `202` et transmet la clé au service.
3. Vérifie que `POST /api/auth/refresh` répond `200` avec la nouvelle paire de tokens.
4. Vérifie qu’un champ JSON inconnu est refusé avec l’enveloppe d’erreur stable.
5. Vérifie que le logout transmet le `device_id` optionnel à supprimer.
6. Vérifie le format stable `404 route_not_found` pour une route inconnue.

### `test/e2e/discovery.contract.spec.ts` — 6 tests

Cette suite démarre Fastify avec le contrôleur de découverte et des dépendances contrôlées :

1. Vérifie le contrat et l’absence de consommation de quota de `GET /api/users/me/discovery-status`.
2. Vérifie `POST /api/swipes`, son statut `201`, son payload et son rate limit dédié.
3. Vérifie que le DTO refuse UUID et décision invalides avant le service.
4. Vérifie la conversion de `limit` et le transfert du curseur de `GET /api/feed`.
5. Vérifie l’enveloppe HTTP stable `503 discovery_unavailable` quand le service signale une panne Scylla.
6. Vérifie que l’ancienne route `POST /api/fake-match` répond désormais au format stable `404 route_not_found`.

### `test/e2e/mobile.contract.spec.ts` — 3 tests

Cette suite démarre Fastify avec le contrôleur mobile :

1. Vérifie l’enregistrement d’un appareil, le statut `201` et l’absence du jeton FCM dans la réponse.
2. Vérifie la liste et la suppression d’un appareil dans le contexte de l’utilisateur authentifié.
3. Vérifie le rejet d’un jeton trop court ou d’une plateforme non supportée avant le service.

### `test/e2e/billing.contract.spec.ts` — 3 tests

1. Vérifie `POST /api/users/me/subscription/checkout`, son statut `201`, la période et la clé d’idempotence.
2. Refuse un `price_id` injecté par le client avant d’atteindre le service.
3. Vérifie que le webhook reçoit les octets JSON bruts inchangés et l’en-tête `Stripe-Signature`.

## Tests d’intégration réels

### `test/integration/postgres.schema.integration.spec.ts` — 27 tests

La suite utilise un vrai pool PostgreSQL et le schéma effectivement migré :

1. **Tables requises** — vérifie aussi `billing_customer`, `billing_checkout_session`, `stripe_webhook_event` et `billing_invoice`.
2. **Index requis et nettoyage** — vérifie les index de recherche, purge, pagination, messages non lus et idempotence, les index OTP dont la contrainte unique d’un code utilisable, l’unicité d’un consentement actif et l’absence des index redondants retirés.
3. **Livraison OTP réelle** — confirme qu’un code devient utilisable seulement après acceptation fournisseur, qu’un retry de la clé n’insère rien et qu’un nouvel envoi échoué ne désactive pas le code précédent.
4. **Livraison abandonnée** — vieillit une ligne `pending`, rejoue sa clé et vérifie son passage à `failed` avec `delivery_unknown`.
5. **Concurrence OTP** — termine deux acceptations fournisseur simultanément et vérifie qu’un seul code reste `sent` et non utilisé.
6. **Requêtes de rétention réelles** — exécute les onze requêtes contre PostgreSQL afin de détecter les erreurs SQL ou de typage que les mocks unitaires ne voient pas.
7. **Démarrage Nest et OpenAPI** — démarre le graphe applicatif complet et vérifie aussi les quatre routes Stripe et leurs schémas.
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
18. **Idempotence des messages** — rejoue le même envoi, retrouve le même UUID sans doublon et refuse une clé réutilisée avec un autre contenu.
19. **Résumé mobile d’un match** — vérifie le profil joint, le dernier message, le compteur non lu et le masquage de la photo jusqu’à la révélation mutuelle.
20. **Lecture groupée** — marque tous les messages reçus jusqu’à une borne, sans marquer ceux envoyés par le demandeur.
21. **Jeton de suppression à usage unique** — accepte le bon hash une seule fois et refuse un hash erroné ou un replay.
22. **Webhook Stripe idempotent** — traite l’Event ID une seule fois malgré un retry.
23. **Droits Stripe** — accorde Premium uniquement aux statuts autorisés dans la période courante et rétrograde sinon.
24. **Nettoyage Stripe RGPD** — retire Customer/session/projection et détache la facture lors de l’anonymisation.
25. **Checkout transactionnel** — rejoue la même clé/session et bloque une deuxième session vivante.
26. **Ordre des événements** — empêche un événement Stripe ancien d’écraser une projection d’abonnement ou une facture plus récente.
27. **Essai non réattribuable** — remplace un Customer supprimé tout en conservant la preuve d’essai consommé.

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
5. exécuter `pnpm test` pour les 199 cas autonomes ;
6. exécuter `pnpm run test:integration` pour les 39 cas réels et vérifier que les 238 cas passent au total.

La validation du 23 août 2026 a réussi : **36 suites et 199 cas autonomes**, ainsi que les **39 cas réels** : 27 PostgreSQL/OpenAPI, 10 ScyllaDB/PostgreSQL et 2 Redis. Le build, TypeScript et ESLint sont également verts, `pnpm audit` ne signale aucune vulnérabilité connue, et le moteur de migration confirme que `histae-dev` est compatible avec la migration `014`.

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
- tests d’un webhook de suivi de livraison Sweego et d’une perte de réponse fournisseur ;
- test Stripe sandbox automatisé dans un environnement éphémère, incluant SCA, renouvellement, annulation et remboursement.
