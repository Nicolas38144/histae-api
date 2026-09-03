# Histae API — résumé du projet

Mise à jour : 3 septembre 2026.

Ce document donne le contexte utile pour reprendre le projet. Il ne répète plus chaque route ni chaque scénario
de test : consulter respectivement `routes.md` et `test.md` pour ces inventaires détaillés.

## 1. État actuel

Histae API est un backend NestJS 11/Fastify 5 en TypeScript strict pour l’application mobile de rencontres Histae.
Le socle fonctionnel principal est implémenté :

- authentification mobile par OTP SMS/JWT et authentification administrateur WebAuthn native ;
- onboarding, profil, questions/réponses guidées, préférences, traits et consentements ;
- découverte distribuée, swipes et création de match par like réciproque ;
- cycle de vie des matchs, révélation mutuelle, continuation et messagerie ;
- blocage, signalement, modération et audit des accès administratifs ;
- appareils, push sans contenu privé et événements SSE ;
- abonnement Premium et projection Stripe ;
- demandes RGPD, export, effacement et maintenance de rétention ;
- photos privées normalisées en WebP dans un stockage objet compatible S3 ;
- qualité et modération des photos, bios et réponses libres avec file de revue auditée ;
- health checks, migrations contrôlées et tests réels des stockages.

Le refactor du 1er septembre 2026 a séparé le cycle de vie HTTP du bootstrap, isolé les parseurs de configuration,
consolidé les migrations PostgreSQL et corrigé plusieurs points de défense en profondeur. La migration
`002_user_photo_lifecycle` a ensuite remplacé la clé provisoire du profil par un registre d’objets versionnés,
réconciliable après une panne PostgreSQL/S3. La migration `003_photo_idempotency_and_outbox` rend l’upload
idempotent pendant 24 heures et découple les suppressions objet par une outbox PostgreSQL durable. Le check-up
complet est dans `docs/security-checkup.md`. La migration `004_admin_photo_reconciliation` ajoute l’action d’audit
qui permet aux opérateurs de relancer les cycles photo bloqués depuis le dashboard. La migration
`005_profile_questions` fournit un catalogue initial administrable et jusqu’à trois réponses ordonnées par profil.
La migration `006_content_moderation` sépare ensuite le statut éditorial du statut technique et crée la file de
revue centrale pour les photos, bios et réponses. `007_native_admin_webauthn` sépare enfin totalement le dashboard
du parcours OTP : passkeys découvrables, sessions serveur courtes et audit d’authentification, sans SSO externe.

## 2. Architecture

### Stack

- Node.js 22+, pnpm 11.22.0, TypeScript strict ;
- NestJS 11 sur Fastify 5 ;
- SimpleWebAuthn côté serveur pour le standard WebAuthn administrateur ;
- PostgreSQL via `pg` ;
- ScyllaDB via `cassandra-driver` ;
- Redis pour le rate limiting et le relais Pub/Sub SSE ;
- SDK AWS v3 pour un stockage objet S3-compatible ;
- Sharp et `heic-decode` pour les photos ;
- un service local optionnel FastAPI/OpenCV/ONNX pour la détection de visage, la netteté et le score NSFW ;
- Sweego pour les OTP, FCM pour le push, Stripe pour la facturation ;
- Jest pour les tests unitaires, e2e et d’intégration.

### Responsabilité des stockages

PostgreSQL est l’autorité transactionnelle pour les comptes, profils, questions/réponses, consentements, préférences, traits,
abonnements, matchs, messages, signalements, cas de modération, appareils, notifications, audit et workflows RGPD.

ScyllaDB ne stocke que les décisions de découverte, dans deux tables orientées requêtes : actions sortantes et
décisions reçues. Les profils ne sont jamais dupliqués dans Scylla. Un TTL limite naturellement la rétention.

Redis porte les compteurs de débit partagés et le bus d’événements temps réel inter-instances. En production, son
indisponibilité fait échouer fermement la protection avec `503`, au lieu de laisser passer les requêtes.

Le stockage objet ne contient que les photos privées. SeaweedFS `weed mini` est le choix local pour une machine,
pas une dépendance applicative : changer de fournisseur revient à modifier les six variables `OBJECT_STORAGE_*`.

### Organisation des sources

Les domaines sont dans `src/admin`, `auth`, `billing`, `discovery`, `matches`, `mobile`, `moderation`, `outbox`, `photos`, `plans`,
`privacy`, `profile-questions`, `reports`, `traits` et `users`. Les briques transverses sont dans `common`, `config`, `crypto`,
`database`, `ratelimit`, `redis`, `scylla` et `storage`.

La convention est : contrôleur pour HTTP, DTO pour la validation stricte des entrées, service pour les règles métier, repository
ou store pour SQL/CQL et mapper/model pour les représentations publiques.

## 3. Contrat HTTP et sécurité

Les routes métier sont sous `/api`. Les seules exceptions sont `/health/live` et `/health/ready`. L’API
n’embarque ni OpenAPI ni Swagger ; le contrat HTTP est maintenu dans `routes.md`.

Les corps JSON sont limités à 1 Mio. Les DTO utilisent une whitelist stricte et rejettent les champs inconnus.
Les erreurs publiques suivent toujours :

```json
{
  "error": {
    "code": "stable_code",
    "message": "Human-readable message"
  }
}
```

Les réponses portent un `X-Request-ID`, `Cache-Control: no-store` et des en-têtes défensifs centralisés. Un UUID
client n’est conservé que s’il est v4. HSTS est ajouté en production. Les logs HTTP enregistrent méthode, chemin
sans query string, statut, identifiant et durée, jamais les recherches ou motifs présents dans l’URL.

`TRUST_PROXY=false` est le défaut. En production, `true` est interdit : il faut lister exactement les IP/CIDR des
proxies autorisés, sinon une adresse transmise par le client pourrait fausser les journaux et limites par IP.

### Authentification et autorisation

- Access token JWT HS256, typé `access`, avec issuer `histae-api` et audience `histae-app`.
- Le rôle, le bannissement, la suppression et l’état juridique sont relus dans PostgreSQL à chaque requête ;
  aucune autorité n’est accordée à un rôle fourni par le client ou resté dans un ancien token.
- Refresh token au format `UUIDv4:secret-base64url`, secret aléatoire de 256 bits, hash SHA-256 en base, rotation
  et révocation transactionnelles.
- OTP à six chiffres stocké sous forme de HMAC, à usage unique, activé seulement après acceptation du SMS par le
  fournisseur et protégé par idempotence.
- Numéro limité actuellement au format français E.164. Le clair n’est ni persisté ni journalisé : HMAC-SHA-256
  pour l’index et AES-256-GCM avec nonce/tag pour la valeur récupérable.
- Les administrateurs ont des contrôles de rôle en base. Les accès aux détails personnels et conversations
  exigent un motif et créent une trace dans `data_access_log`.
- Les routes admin refusent les JWT mobiles et exigent une passkey WebAuthn avec vérification utilisateur. Les clés
  privées ne quittent jamais l’authenticator ; seuls la clé publique, le compteur, les secrets opaques hashés et les
  événements d’authentification sont stockés.
- Les sessions admin vivent dans un cookie `HttpOnly; SameSite=Strict`, expirent après 30 minutes d’inactivité et
  8 heures au maximum, sont relues dans PostgreSQL à chaque requête et deviennent invalides avec le compte ou la
  passkey. Les mutations vérifient l’origine exacte contre les requêtes intersites.
- En développement, WebAuthn utilise `http://localhost:5173` et le RP ID `localhost` derrière le proxy Vite `/api`.
  La production exige une origine HTTPS et un cookie `__Host-…; Secure`.

Le rate limiting est global par IP et renforcé sur WebAuthn admin, OTP, refresh, feed, swipe, message, export,
signalement, photo, facturation et webhook Stripe. Les clés de compteurs sont HMACées. Le fallback mémoire non-production purge ses
entrées expirées.

### Consentements et confidentialité

Les quatre choix juridiques sont :

- acceptation des CGU ;
- accusé de présentation de la notice de confidentialité ;
- consentement aux données sensibles ;
- consentement de localisation.

Il n’existe pas de consentement marketing. Les deux premiers choix et leurs versions courantes conditionnent les
routes utilisateur normales. Le sexe et les préférences nécessitent le consentement sensible ; la présence exige
celui de localisation. Leur retrait efface immédiatement les données correspondantes.

L’export RGPD contient les données de l’utilisateur dans PostgreSQL et uniquement ses décisions Scylla sortantes :
les décisions entrantes de tiers restent secrètes. L’effacement supprime d’abord l’identité Stripe et la photo,
efface les données Scylla, puis anonymise PostgreSQL. Les factures requises pour la comptabilité sont détachées du
compte. Un tombstone temporaire n’est gardé que pour empêcher un compte banni de contourner la sûreté par effacement.

## 4. Règles métier essentielles

### Profil et onboarding

La date de naissance est une date calendrier stricte `YYYY-MM-DD`; les dates impossibles sont refusées et le
contrôle des 18 ans existe dans l’application comme dans PostgreSQL. Les valeurs de sexe/préférence viennent de
types fermés et ne sont acceptées qu’avec le consentement requis.

Le catalogue propose initialement quinze questions réparties en cinq catégories. Un utilisateur remplace
atomiquement une sélection ordonnée de zéro à trois réponses, chacune liée à une question distincte et limitée à
10–300 caractères. Le propriétaire et l’export RGPD conservent toutes les réponses ; le feed et les matchs ne
projettent que celles dont la modération est `approved`. Le dashboard admin peut ajouter, modifier et supprimer les
questions. Une suppression est physique et entraîne volontairement toutes les réponses liées par `ON DELETE
CASCADE`, après avertissement sur leur nombre.

### Découverte et matchs

Le feed combine les candidats relationnels PostgreSQL avec les décisions Scylla déjà prises. Les écritures CQL
sont immuables pendant leur TTL. Les likes réciproques créent un seul match grâce à la concurrence Scylla et à
l’unicité/transaction PostgreSQL.

Un match est actif pendant 24 heures, peut ensuite attendre la continuation, puis devient confirmé ou expiré.
La continuation et le quota Free sont atomiques. Les messages exigent une participation valide, respectent l’état
du match et utilisent un UUID v4 d’idempotence ; rejouer la même mutation retourne le même message.

Le push ne contient jamais le texte d’un message. Il transporte uniquement des identifiants de resynchronisation.
Le flux SSE annonce les créations/mises à jour de match, invalidations, messages, lectures et abonnements.

### Photos privées

`PUT /api/users/me/photo` exige `Idempotency-Key: <UUID v4>` et accepte un unique champ multipart `photo`. Les
extensions admises sont `.jpg`, `.jpeg`, `.png`, `.heic`, `.heif` et `.webp`. L’entrée comme le WebP produit sont
limitées à **500 000 octets**.

Le processeur vérifie extension, MIME, signature binaire, pixels et dimensions, borne le décodage HEIC, applique
l’orientation, réduit à 2 048 px maximum et retire les métadonnées. Chaque WebP final reçoit une clé immuable :

```text
profile-photos/<user_uuid>/<photo_uuid>.webp
```

La table `user_photo` conserve l’état `pending | processing | ready | deleting`, la clé privée, le MIME, la taille,
les dimensions et le SHA-256. Les contraintes garantissent au plus une photo `ready` et une conversion en cours
par utilisateur. `photo_upload_request` conserve pendant 24 heures la clé d’idempotence et un SHA-256 borné du
nom, du MIME et du contenu source, jamais la photo. Un retry identique d’une demande terminée renvoie la photo
courante sans nouvelle conversion ; un contenu différent ou un résultat déjà remplacé est refusé explicitement.

L’activation rend la nouvelle version techniquement `ready`, passe l’ancienne à `deleting`, termine l’état d’idempotence et
insère `photo.delete` dans `outbox_event`, le tout dans la même transaction. Le worker supprime ensuite l’objet et
la ligne technique avec verrous `SKIP LOCKED`, concurrence bornée, backoff exponentiel, dix tentatives et état
`dead_letter`. Une écriture S3 incertaine reste réconciliable par la maintenance horaire. La photo n’est publique
qu’après approbation de son cas de modération associé.

`GET /api/admin/metrics` agrège les états photo, les traitements anciens de plus de 30 minutes, les dead letters et
les suppressions sans événement actif. `GET /api/admin/photo-reconciliation` expose une file technique paginée sans clé
objet ni image. `POST /api/admin/photo-reconciliation/:id/retry` refuse les photos `ready` et les workers actifs,
puis rend l’objet invisible, remet `photo.delete` en file et inscrit `admin_reconcile_photo` avec le motif dans une
unique transaction PostgreSQL.

PostgreSQL ne contient jamais d’URL publique ou signée. Les URL signées expirent après cinq minutes et ne sont
générées que pour le propriétaire, un export du propriétaire, un match après révélation mutuelle ou un détail
admin audité. Les collections admin et blocages renvoient toujours `photo: null`. Les appels S3 réseau sont bornés
à dix secondes.

### Qualité et modération des contenus

`content_moderation_case` conserve un statut `pending | approved | rejected` indépendant du cycle technique et
référence exactement une photo, une bio ou une réponse. Chaque modification remplace la décision précédente de ce
contenu. Les contenus existant lors de la migration sont classés `pending/legacy_unreviewed` : ce choix fail-safe
les masque du feed et des matchs jusqu’à leur revue, sans les supprimer ni les cacher à leur propriétaire.

La bio et les réponses utilisent des règles locales explicables pour repérer spam, insultes, coordonnées
personnelles et vocabulaire sexuel. Une photo WebP peut être transmise au service local optionnel
`services/photo-moderation`, authentifié par token et borné par timeout : OpenCV compte les visages et mesure la
netteté, tandis qu’un petit modèle ONNX calcule un score NSFW. Un contenu sans signal est automatiquement
`approved`; un signal ou une analyse indisponible produit `pending`. L’automatisation ne rejette jamais seule.

La liste `GET /api/admin/content-moderation` ne contient ni texte, ni clé objet, ni URL. Le détail exige un motif,
audite `view_moderation_content`, puis seulement signe la photo éventuelle. Une décision est protégée par version
optimiste et audite `admin_review_content`. Pour une photo, le reviewer doit attester visage détectable, netteté et
contenu autorisé ; un rejet rend la photo invisible, la passe à `deleting` et écrit `photo.delete` dans l’outbox au
sein de la même transaction.

## 5. Facturation

Stripe Checkout accepte uniquement la période mensuelle ou annuelle ; les Product/Price IDs et tarifs viennent de
la configuration et du catalogue serveur. Les créations sont idempotentes et une seule session live est admise.

Le webhook utilise le corps brut et la signature Stripe, une limite dédiée, une table de déduplication et l’ordre
temporel des événements pour empêcher un événement ancien d’écraser un état plus récent. PostgreSQL garde la
projection d’abonnement et le registre des factures, mais l’estimation admin ne doit pas être présentée comme une
comptabilité de trésorerie.

## 6. PostgreSQL et migrations

Le schéma canonique est `db/schema_postgres.sql`. Les catalogues de plans/traits et le seed conditionnel des 400
profils de développement sont dans `db/insert_postgres.sql`. `db/drop_postgres.sql` n’est utilisé que par le reset
local protégé.

Les quinze anciens fichiers incrémentaux ont été fusionnés dans la baseline logique `001_baseline_20260901`.
Le moteur compose le schéma et les inserts canoniques, calcule un checksum SHA-256, acquiert un verrou consultatif
et applique la baseline dans une transaction.

La migration incrémentale `002_user_photo_lifecycle` ajoute le registre versionné des objets photo et retire la
colonne provisoire `user_profile.photo`. `003_photo_idempotency_and_outbox` ajoute les demandes d’upload à durée
bornée et l’outbox générique. `004_admin_photo_reconciliation` étend la liste fermée des actions d’audit pour la
relance opérateur. `005_profile_questions` ajoute le catalogue administrable et les réponses en cascade.
`006_content_moderation` ajoute les cas centraux, les signaux automatisés, la revue optimiste et les actions
d’audit associées. `007_native_admin_webauthn` ajoute les enrôlements temporaires, credentials publics, challenges,
sessions opaques et événements d’authentification admin. Une base neuve applique donc la baseline puis ces migrations
dans l’ordre.

La compatibilité est sans perte :

- une base neuve applique la baseline puis toutes les migrations incrémentales ;
- une base possédant les quinze anciennes versions est vérifiée structurellement puis reçoit la marque de baseline,
  sans rejouer le schéma et sans supprimer son historique ;
- une historique ancienne partielle est refusée avec une erreur explicite ;
- une baseline déjà enregistrée dont le checksum change est refusée.

Après déploiement de la baseline, toute évolution persistante doit reprendre sous forme de migration incrémentale.
`pnpm run db:reset` reste séparé et refuse toute cible autre que `ENV=development`, PostgreSQL local et la base
`histae-dev`.

Scylla garde son registre `scylla_schema_migrations` et son unique fichier `scylla/001_discovery.cql`. Le reset
Scylla ne touche que les tables de swipes du keyspace local autorisé et conserve le schéma/historique.

## 7. Exploitation

`/health/live` indique que le processus répond. `/health/ready` vérifie PostgreSQL, Scylla quand activé, Redis quand
activé et le bucket objet. La fermeture Nest libère les pools/clients.

La maintenance peut fonctionner dans l’API, dans un worker séparé ou être désactivée. Elle expire notamment les
présences, OTP, refresh tokens, notifications, consentements retirés, demandes RGPD closes, journaux d’accès,
signalements, tombstones, jetons de suppression, matchs et messages selon `docs/retention-policy.md`. Elle réconcilie
également les challenges/enrôlements WebAuthn consommés ou expirés, sessions admin obsolètes et audits de plus d’un
an. Elle réconcilie aussi les conversions photo abandonnées, les clés d’idempotence expirées et, comme filet de sécurité, les objets
dont la suppression S3 doit être retentée.

L’outbox est consommée chaque seconde par l’API lorsque `MAINTENANCE_MODE=api`. Pour séparer le trafic HTTP des
effets externes, `MAINTENANCE_MODE=worker pnpm run outbox:work` lance un consommateur dédié et arrêtable proprement.
Les événements terminés sont purgés après sept jours ; les dead letters restent visibles pour diagnostic et
rejeu opérateur futur.

En local, les Compose sont séparés pour ScyllaDB, Redis, SeaweedFS et l’analyse photo. Le Compose objet lie l’API S3 à
`127.0.0.1:8333`, crée le bucket privé et possède un healthcheck. Ce montage mono-machine n’est pas une cible de
production. `docker-compose.photo-moderation.yml` lie le service CPU sur `127.0.0.1:8090`, l’exécute sans
privilège, en lecture seule, avec ressources bornées et healthcheck. Il ne reçoit que le WebP déjà normalisé et ne
le persiste pas.

## 8. Validation et documents de référence

Commandes autonomes :

```powershell
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run test:unit
pnpm run test:e2e
pnpm test
```

Avec PostgreSQL, ScyllaDB et Redis locaux :

```powershell
pnpm run test:integration
```

L’inventaire, les prérequis et les derniers résultats se trouvent dans `test.md`. Les autres références sont :

- `routes.md` : contrat HTTP exhaustif ;
- `.env.example` : variables et valeurs locales documentées ;
- `docs/security-checkup.md` : portée, corrections et risques résiduels de sécurité ;
- `docs/retention-policy.md` : durées et opérations de purge ;
- `docs/legal-release-checklist.md` : décisions juridiques à obtenir avant mise en production ;
- `AGENTS.md` : invariants de travail pour les futures modifications.

## 9. Ce qu’il reste à faire

### Priorité production

1. Choisir l’architecture cible et tester sauvegarde/restauration de PostgreSQL et du stockage objet, ainsi que
   réplication, réparation et montée de version ScyllaDB. Prévoir Redis hautement disponible.
2. Déployer une chaîne TLS complète avec reverse proxy/WAF, IP/CIDR de confiance précis, protection DDoS,
   gestionnaire de secrets et procédures de rotation/révocation.
3. Formaliser l’exploitation de WebAuthn : deux passkeys minimum par administrateur, clé physique de secours,
   procédure d’enrôlement/récupération hors bande et alertes sur les connexions et actions de sûreté.
4. Calibrer les seuils photo et les règles texte sur un corpus représentatif, mesurer faux positifs, faux négatifs
   et biais, formaliser toutes les catégories interdites, le SLA de revue et une procédure d’appel.
5. Compléter les métriques déjà présentes pour `user_photo` et la file de modération par une collecte d’observabilité sur les latences,
   erreurs, pools, rate limits, OTP, Stripe, S3 et Scylla, puis définir les alertes. Déployer et superviser réellement
   les workers maintenance/outbox.
6. Implémenter le suivi asynchrone Sweego (webhook/statut) pour distinguer acceptation fournisseur et livraison,
   puis gérer explicitement la perte de réponse réseau.
7. Ajouter une réconciliation Stripe planifiée et un traitement opérable des webhooks durablement en échec.

### Validation à étendre

1. Pentest externe authentifié et tests d’abus/charge, notamment OTP, autorisations objet, multipart/HEIC,
   concurrence de swipes/continuations, webhooks et URLs signées.
2. Tests PostgreSQL réels supplémentaires sur refresh token, tombstones, retraits de consentement, quota Free
   concurrent, pagination matchs/signalements et maintenance avec données expirées.
3. Tests de panne/reprise Redis, Scylla, S3, Sweego et Stripe, plus un parcours Stripe sandbox complet.
4. Intégrer audit de dépendances, secret scanning et SAST récurrents quand la chaîne CI/CD sera décidée.

### Décisions produit, juridique et exploitation

Finaliser avec le DPO/juriste l’AIPD, les durées des comptes inactifs, les sous-traitants/transferts, la gestion des
sauvegardes lors d’un effacement et les textes/versionnements de production. Ces choix ne doivent pas être inventés
dans le code.

À court terme, le meilleur prochain lot côté API est le suivi Sweego et l’observabilité. Le socle métier n’a pas
besoin d’une nouvelle réécriture générale ; les risques principaux sont désormais les procédures de récupération
WebAuthn et les garanties opérationnelles des services externes.
