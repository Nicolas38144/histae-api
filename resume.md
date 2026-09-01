# Histae API — résumé du projet

Mise à jour : 1er septembre 2026.

Ce document donne le contexte utile pour reprendre le projet. Il ne répète plus chaque route ni chaque scénario
de test : consulter respectivement `routes.md` et `test.md` pour ces inventaires détaillés.

## 1. État actuel

Histae API est un backend NestJS 11/Fastify 5 en TypeScript strict pour l’application mobile de rencontres Histae.
Le socle fonctionnel principal est implémenté :

- authentification par OTP SMS et rotation des sessions ;
- onboarding, profil, préférences, traits et consentements ;
- découverte distribuée, swipes et création de match par like réciproque ;
- cycle de vie des matchs, révélation mutuelle, continuation et messagerie ;
- blocage, signalement, modération et audit des accès administratifs ;
- appareils, push sans contenu privé et événements SSE ;
- abonnement Premium et projection Stripe ;
- demandes RGPD, export, effacement et maintenance de rétention ;
- photos privées normalisées en WebP dans un stockage objet compatible S3 ;
- health checks, migrations contrôlées et tests réels des stockages.

Le refactor du 1er septembre 2026 a séparé le cycle de vie HTTP du bootstrap, isolé les parseurs de configuration,
consolidé les migrations PostgreSQL et corrigé plusieurs points de défense en profondeur. Le check-up complet est
dans `docs/security-checkup.md`.

## 2. Architecture

### Stack

- Node.js 22+, pnpm 11.22.0, TypeScript strict ;
- NestJS 11 sur Fastify 5 ;
- PostgreSQL via `pg` ;
- ScyllaDB via `cassandra-driver` ;
- Redis pour le rate limiting et le relais Pub/Sub SSE ;
- SDK AWS v3 pour un stockage objet S3-compatible ;
- Sharp et `heic-decode` pour les photos ;
- Sweego pour les OTP, FCM pour le push, Stripe pour la facturation ;
- Jest pour les tests unitaires, e2e et d’intégration.

### Responsabilité des stockages

PostgreSQL est l’autorité transactionnelle pour les comptes, profils, consentements, préférences, traits,
abonnements, matchs, messages, signalements, appareils, notifications, audit et workflows RGPD.

ScyllaDB ne stocke que les décisions de découverte, dans deux tables orientées requêtes : actions sortantes et
décisions reçues. Les profils ne sont jamais dupliqués dans Scylla. Un TTL limite naturellement la rétention.

Redis porte les compteurs de débit partagés et le bus d’événements temps réel inter-instances. En production, son
indisponibilité fait échouer fermement la protection avec `503`, au lieu de laisser passer les requêtes.

Le stockage objet ne contient que les photos privées. SeaweedFS `weed mini` est le choix local pour une machine,
pas une dépendance applicative : changer de fournisseur revient à modifier les six variables `OBJECT_STORAGE_*`.

### Organisation des sources

Les domaines sont dans `src/admin`, `auth`, `billing`, `discovery`, `matches`, `mobile`, `photos`, `plans`,
`privacy`, `reports`, `traits` et `users`. Les briques transverses sont dans `common`, `config`, `crypto`,
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

Le rate limiting est global par IP et renforcé sur OTP, refresh, feed, swipe, message, export, signalement, photo,
facturation et webhook Stripe. Les clés de compteurs sont HMACées. Le fallback mémoire non-production purge ses
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

`PUT /api/users/me/photo` accepte un unique champ multipart `photo`. Les extensions admises sont `.jpg`, `.jpeg`,
`.png`, `.heic`, `.heif` et `.webp`. L’entrée comme le WebP produit sont limitées à **500 000 octets**.

Le processeur vérifie extension, MIME, signature binaire, pixels et dimensions, borne le décodage HEIC, applique
l’orientation, réduit à 2 048 px maximum et retire les métadonnées. Seul le WebP final est conservé sous :

```text
profile-photos/<user_uuid>/photo.webp
```

PostgreSQL ne contient jamais d’URL publique ou signée. Les URL signées expirent après cinq minutes et ne sont
générées que pour le propriétaire, un export du propriétaire, un match après révélation mutuelle ou un détail
admin audité. Les collections admin et blocages renvoient toujours `photo: null`. Les appels S3 réseau sont bornés
à dix secondes.

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

La compatibilité est sans perte :

- une base neuve applique cette unique baseline ;
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
signalements, tombstones, jetons de suppression, matchs et messages selon `docs/retention-policy.md`.

En local, les Compose sont séparés pour ScyllaDB, Redis et SeaweedFS. Le Compose objet lie l’API S3 à
`127.0.0.1:8333`, crée le bucket privé et possède un healthcheck. Ce montage mono-machine n’est pas une cible de
production.

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
3. Renforcer l’accès administrateur avec SSO/MFA résistante au phishing, sessions plus courtes et alertes sur les
   accès personnels ou actions de sûreté.
4. Ajouter métriques, tableaux de bord et alertes sur latences, erreurs, pools, rate limits, OTP, Stripe, S3,
   Scylla et retard de maintenance. Planifier réellement le worker de maintenance.
5. Implémenter le suivi asynchrone Sweego (webhook/statut) pour distinguer acceptation fournisseur et livraison,
   puis gérer explicitement la perte de réponse réseau.
6. Ajouter une réconciliation Stripe planifiée et un traitement opérable des webhooks durablement en échec.

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
besoin d’une nouvelle réécriture générale ; les risques principaux sont désormais l’authentification admin et les
garanties opérationnelles des services externes.
