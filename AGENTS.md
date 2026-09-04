# AGENTS.md — Histae API

Ces instructions s'appliquent à tout le dépôt `histae-api`.

## Contexte du projet

Histae API est le backend TypeScript de l'application mobile de rencontres Histae. Le projet utilise NestJS 11 avec Fastify 5 et expose ses routes métier sous `/api`. Les seules exceptions sont `/health/live` et `/health/ready`. L'API n'embarque ni OpenAPI ni Swagger ; `routes.md` est la référence du contrat HTTP.

Les sources de référence à consulter avant une modification importante sont :

- `resume.md` pour l'architecture, les règles métier, les risques ouverts et la feuille de route ;
- `docs/roadmap.md` pour le backlog détaillé, les limites constatées, les priorités et les critères de fin ;
- `routes.md` pour le contrat HTTP existant ;
- `test.md` pour les commandes, prérequis, règles d’isolation et limites de validation ; les scénarios détaillés restent dans les tests, les bilans de lots dans la roadmap ;
- `docs/retention-policy.md` et `docs/legal-release-checklist.md` pour la rétention et les contraintes juridiques ;
- `.env.example` pour la configuration prise en charge.

Si le code et la documentation divergent, vérifier le comportement par les tests et signaler explicitement la divergence. Toute modification de contrat, d'architecture, de commande ou de couverture doit mettre à jour les documents concernés dans le même changement.

## Stack et responsabilités des stockages

- Node.js 22+, pnpm 11.22.0, TypeScript strict.
- PostgreSQL est la source de vérité transactionnelle pour les comptes, profils, questions/réponses de profil, consentements, abonnements, matchs, messages, signalements et workflows RGPD.
- ScyllaDB conserve uniquement les décisions de découverte à fort volume et leurs vues par acteur/cible.
- Redis fournit le rate limiting distribué et le relais Pub/Sub SSE entre instances.
- Le stockage objet compatible S3 conserve les photos privées. SeaweedFS `weed mini` est uniquement le choix local ; le code ne doit importer aucun type ou comportement propre à SeaweedFS.
- Sweego livre les OTP par SMS, Firebase Cloud Messaging fournit le push optionnel et Stripe gère la facturation Premium.

Ne dupliquer ni profils ni autres données personnelles de référence dans ScyllaDB. Les opérations d'export ou d'effacement doivent préserver la séparation PostgreSQL/Scylla et l'ordre des effets externes documenté.

## Organisation du code

Le code est organisé par domaines dans `src/` : `admin`, `admin-auth`, `auth`, `billing`, `discovery`, `matches`, `mobile`, `moderation`, `outbox`, `photos`, `plans`, `privacy`, `profile-questions`, `reports`, `traits`, `users`, ainsi que les briques partagées `common`, `config`, `crypto`, `database`, `ratelimit`, `redis`, `scylla` et `storage`.

Respecter autant que possible la séparation suivante :

- contrôleur : contrat HTTP, guards, DTO et statut de réponse ;
- DTO : validation stricte des entrées HTTP ;
- service : règles métier et traduction en erreurs API stables ;
- repository/store : SQL/CQL, transactions, verrous et accès aux données ;
- mapper/model : types métier fermés et représentation publique.

Dans les matchs, la messagerie appartient à `MatchMessageRepository` et les tâches de fond à
`MatchMaintenanceRepository`. Dans l'administration, isoler les agrégats dans `AdminMetricsRepository` et la
réconciliation dans `AdminPhotoRepository`. Les webhooks Stripe appartiennent à `StripeWebhookService`, pas aux
parcours client de `BillingService`. Les helpers `match-access.ts` et `admin-audit.ts` reçoivent la transaction de
l'appelant et ne doivent pas en ouvrir une autre. Voir `docs/module-responsibilities.md`.

## Invariants à préserver

- Les DTO refusent les champs inconnus. Ne pas accepter de champs de privilège ou d'identifiants/prix Stripe choisis par le client.
- Les erreurs publiques utilisent toujours `{ "error": { "code", "message" } }` et n'exposent aucune stack.
- Les réponses portent les en-têtes défensifs centralisés dans `common/http/http-lifecycle.ts`; ne pas les dupliquer dans les contrôleurs.
- Les dates de naissance sont des dates calendrier strictes `YYYY-MM-DD` et l'utilisateur doit avoir au moins 18 ans.
- Les téléphones sont actuellement limités au format français E.164. Ne jamais persister ni journaliser le numéro en clair.
- Les access tokens sont des JWT HS256 typés `access`. Les rôles et l'état du compte sont relus depuis PostgreSQL ; ne jamais faire confiance à un rôle fourni par le client ou par un ancien token.
- Les refresh tokens et les OTP sont rotatifs/à usage unique selon les transactions et verrous existants. Préserver l'idempotence des envois OTP.
- `OtpRepository` sérialise acceptation, callbacks et consommation par téléphone pseudonymisé. Sweego distingue `pending/accepted/sent/failed/unknown` ; `sent` ne prouve pas une réception au téléphone. Aucune reprise automatique de POST après une issue incertaine ; le callback HMAC peut confirmer le code initial mais ne réactive jamais un code consommé, expiré ou remplacé. Ne conserver ni payload ni téléphone reçu dans le webhook. Voir `docs/sweego-delivery.md`.
- Les refresh tokens mobiles appartiennent à une famille et conservent leur hash après rotation jusqu'à leur expiration initiale. Seul le rejeu d'un ancêtre authentique non expiré révoque toute sa famille ; un mauvais secret ne révoque rien. Verrouiller le compte avant toute mutation de session et commiter la révocation avant le `401`.
- Les JWT mobiles exigent `sid`, `kid` et `exp`, avec HS256, issuer/audience/types exacts et famille active relue en PostgreSQL. Le `kid` ne sélectionne qu'une clé locale configurée. Préserver la révocation ciblée/globale, la suppression des appareils push liés, l'export et l'effacement des familles ; aucun refresh concurrent ou retry aveugle n'est toléré côté mobile. Voir `docs/mobile-sessions.md`.
- L’OTP/JWT authentifie le client mobile uniquement. Toute route administrative doit utiliser `AdminSessionGuard` et ne doit jamais accepter un JWT mobile, même pour un compte de rôle `admin`.
- L’authentification admin est WebAuthn native : vérification utilisateur et credential découvrable obligatoires, challenge et bootstrap à usage unique, origine/RP ID exacts, compteur vérifié, session opaque hashée en base et cookie `HttpOnly; SameSite=Strict`. Toute mutation admin doit refuser une origine différente de `ADMIN_WEBAUTHN_ORIGIN`.
- En développement WebAuthn utilise exclusivement `http://localhost:5173` avec le RP ID `localhost` et le proxy Vite `/api`; ne pas substituer `127.0.0.1`. En production, imposer HTTPS et le cookie `__Host-…; Secure`.
- La gestion des passkeys et des autres sessions exige une authentification récente. Ne jamais permettre de révoquer la passkey de la session courante, la dernière passkey active ou la session courante via la route de révocation ciblée. Les listes et historiques ne doivent exposer ni token/hash, ni clé publique.
- Les routes utilisateur normales exigent les CGU et la notice courantes. Les routes indispensables à l'onboarding, à la déconnexion et aux droits RGPD restent accessibles selon `routes.md`.
- Le sexe et les préférences exigent le consentement aux données sensibles ; la présence exige le consentement de localisation. Leur retrait doit déclencher l'effacement immédiat documenté.
- Les écritures profil/préférences/présence doivent verrouiller le compte puis relire les versions requises des consentements dans la même transaction. Un précontrôle du service ne suffit pas face à un retrait concurrent.
- Les transitions de match, la continuation, les quotas, l'expiration et l'envoi idempotent des messages doivent rester atomiques.
- Lire l’horloge d’expiration après l’acquisition du verrou de match, dans le SELECT extérieur à la CTE matérialisée. Une attente de verrou ne doit pas prolonger la fenêtre ; une limite de continuation à zéro ne doit pas allouer le premier usage.
- Une décision de swipe est immuable pendant sa rétention. Deux likes réciproques ne doivent créer qu'un match PostgreSQL, même en concurrence.
- Le texte privé d'un message ne doit être ni persisté dans une notification mobile ni transmis à FCM.
- Les notifications match/message/Stripe et leurs tâches `notification.push` par appareil sont écrites dans la transaction métier via `notification-outbox.ts`. Ne jamais réintroduire une programmation après commit. Conserver la clé source/type/destinataire, le `notification_id` stable, les contrôles d’éligibilité avant envoi et les erreurs FCM normalisées. La migration 012 nettoie les notifications intercalées pendant l’effacement ; préserver le verrou partagé du destinataire et ce nettoyage final. Les alertes Stripe doivent respecter le prédicat partagé `notification-billing.ts` à la programmation et à l’envoi ; ne pas exposer leur contexte interne. SSE reste best-effort ; les issues FCM incertaines peuvent produire un doublon externe. Voir `docs/durable-notifications.md`.
- Un utilisateur conserve au plus trois réponses de profil ordonnées, sur des questions distinctes. Leur remplacement reste atomique et leurs textes normalisés, sans caractères de contrôle, entre 10 et 300 caractères et 1 000 octets maximum.
- Supprimer une question de profil supprime volontairement toutes ses réponses par cascade PostgreSQL. Le dashboard doit afficher `answer_count` et demander une confirmation explicite avant cette opération irréversible.
- Une photo reçue ne peut dépasser 500 000 octets et doit porter l’une des extensions `.jpg`, `.jpeg`, `.png`, `.heic`, `.heif`, `.webp`. Vérifier aussi MIME, signature et dimensions ; ne stocker qu’un WebP privé sans métadonnées, lui-même limité à 500 000 octets.
- `PUT /users/me/photo` exige un `Idempotency-Key` UUID v4. Conserver 24 heures uniquement son empreinte de requête et son état ; un replay identique ne doit ni reconvertir ni réécrire l’objet, et une clé réutilisée avec un autre contenu ou un résultat devenu obsolète doit être refusée.
- PostgreSQL ne conserve jamais une URL photo externe ou signée. `user_photo` suit les objets versionnés `profile-photos/<user_uuid>/<photo_uuid>.webp`, leur état et leurs métadonnées techniques vérifiées. Une photo publique doit être à la fois `ready` et modérée `approved` ; l’URL signée courte n’est produite qu’au dernier moment.
- Préserver le protocole photo inter-stockages : créer `processing` et la demande idempotente dans une transaction, persister les métadonnées, écrire l’objet, puis activer atomiquement la nouvelle ligne, terminer la demande, passer l’ancienne à `deleting` et émettre `photo.delete` dans l’outbox. Une issue S3 incertaine doit rester réconciliable ; ne jamais supprimer la trace PostgreSQL avant la suppression confirmée de l’objet.
- Les effets outbox doivent être idempotents, revendiqués avec verrouillage PostgreSQL, bornés en lot/concurrence et réessayés sans persister de détail sensible. Ne pas contourner l’outbox par un appel réseau entre une mutation métier et son commit.
- Une décision opérateur sur une dead letter exige une authentification admin récente, un motif et un audit dans la transaction verrouillée. Ne jamais exposer payload, agrégat ou clé objet dans la liste. Interdire l’abandon de `photo.delete` tant que la ligne `user_photo` existe.
- Les métriques HTTP et dépendances restent agrégées, à cardinalité bornée et sans identifiant utilisateur. L’état persistant de maintenance ne conserve qu’un code d’erreur normalisé, jamais le message ou la stack.
- Une collection administrative ou de blocages ne signe aucune photo. Seul un accès métier explicitement autorisé peut produire un lien signé ; le détail admin exige un motif et une trace d'audit.
- La réconciliation admin ne doit exposer ni `object_key`, ni URL, ni image. Elle ne peut agir sur une photo `ready` ou un traitement récent, ne doit pas reprendre le verrou d’un worker actif et doit écrire `admin_reconcile_photo` avec un motif dans la transaction qui remet `photo.delete` en file.
- Le statut technique d’une photo et son statut de modération sont indépendants. Les bios, réponses libres et photos non approuvées ne doivent jamais être projetées dans le feed ou les matchs ; leur propriétaire conserve leur contenu et voit le statut et les motifs de modération.
- L’automatisation peut approuver un contenu clairement sûr, mais ne doit jamais le rejeter seule. Une panne, un timeout ou une réponse invalide de l’analyseur photo doit échouer fermement vers `pending` avec `analysis_unavailable`.
- La liste de modération admin ne doit exposer ni texte, ni `object_key`, ni URL. Le détail exige un motif, produit `view_moderation_content` avant de signer une photo, et toute décision produit `admin_review_content` dans la transaction métier.
- Une revue photo exige les trois contrôles explicites `face_detectable`, `sharp_enough` et `content_allowed`. Une approbation exige trois valeurs vraies ; un rejet exige au moins une valeur fausse. Rejeter une photo `ready` doit la passer à `deleting` et écrire `photo.delete` dans l’outbox de la même transaction.
- L’accès au stockage doit rester derrière `ObjectStorageService` et les six variables `OBJECT_STORAGE_*`; ne jamais dépendre d’une API SeaweedFS, MinIO, Garage ou fournisseur cloud spécifique.
- Conserver une limite dédiée à l’upload photo en plus de la limite globale, car le décodage HEIC et la conversion sont coûteux.
- Les exports ne révèlent que les swipes sortants de l'utilisateur, jamais les décisions entrantes de tiers.
- La suppression de compte est protégée par un jeton dédié à usage unique et doit nettoyer Stripe/Scylla/PostgreSQL dans l'ordre documenté.
- L’effacement R02 est asynchrone : consommer le jeton, créer DSR/checkpoint/outbox `account.erase` et désactiver le compte dans une seule transaction, puis répondre `202`. `ErasureService` reprend Stripe → photos → Scylla → PostgreSQL hors transaction réseau. Ne terminer la DSR qu’avec l’anonymisation locale ; ne jamais autoriser l’abandon d’un `account.erase`.
- Préserver les guards SQL contre les écritures tardives et les verrous de session `AccountActivityService` des uploads, Checkout et swipes. Normaliser/trier les UUID ; ce pool dédié ajoute quatre connexions maximum et exige un pooling de session. Les lots d’effacement sont bornés et les checkpoints vérifient la propriété du worker. Les intentions Stripe inconnues de plus de 23 heures exigent une réconciliation, jamais un nouveau POST aveugle. Voir `docs/account-erasure.md`.
- Ne pas modifier les durées de rétention sans mettre à jour la politique, les migrations, la maintenance et les tests correspondants.
- Ne pas exposer de secret, `.env`, clé fournisseur, token FCM, téléphone ou justification sensible dans les logs ou les réponses.

## Base de données et migrations

- PostgreSQL utilise la baseline consolidée `001_baseline_20260901`, construite depuis `db/schema_postgres.sql` et `db/insert_postgres.sql`. Les quinze anciennes versions ne subsistent que comme identifiants de compatibilité dans `scripts/migration-catalog.ts`.
- Le schéma Scylla est dans `scylla/001_discovery.cql` et utilise deux vues orientées requêtes, sans index secondaire.
- Les migrations incrémentales `002_user_photo_lifecycle` à `014_sweego_delivery_tracking` ajoutent le cycle photo, l’idempotence/outbox, la réconciliation, les questions, la modération, WebAuthn admin, le suivi des maintenances/récupération auditée des dead letters, les index SQL, les familles de refresh mobiles, les notifications durables par appareil, l’effacement reprenable avec guards d’écriture et le suivi OTP/Sweego. Après ces versions, ajouter une nouvelle migration pour toute évolution persistante. Ne pas modifier une migration déjà déployée sans stratégie explicite de checksum et de compatibilité.
- Les resets sont destructifs et réservés au développement local. `db:reset` doit rester limité à PostgreSQL local `histae-dev`; `db:reset-scylla` doit rester limité au keyspace local `histae_discovery`.
- Ne jamais lancer `DROP`, `TRUNCATE`, `ALTER TABLE` destructif ou un reset contre une cible non vérifiée. Les tests Scylla doivent utiliser des UUID temporaires et un nettoyage ciblé.
- Les tests d'intégration réels attendent PostgreSQL `histae-dev`, Scylla local, Redis local (base logique 15) et le bucket S3 local. Les tests R03 créent leurs schémas, UUID, objets et relais TCP ; ne jamais arrêter les conteneurs partagés pour injecter une panne. Voir `docs/resilience-tests.md`.
- Conserver `patches/cassandra-driver@4.9.0.patch`, `pnpm-workspace.yaml` et `pnpm-lock.yaml` ensemble : le correctif ferme le pool d’un hôte remplacé après coupure. Rejouer le test réseau et vérifier l’arrêt naturel du processus lors d’une évolution du pilote ; ne pas masquer une fuite par `forceExit`.

## Commandes de travail

```powershell
pnpm install --frozen-lockfile
pnpm run db:migrate
pnpm run scylla:migrate
pnpm run start:dev
pnpm run outbox:work
```

Validation autonome, sans infrastructure externe :

```powershell
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm run test:unit
pnpm run test:e2e
pnpm test
```

Validation réelle, avec PostgreSQL, ScyllaDB, Redis et S3 locaux préparés :

```powershell
pnpm run test:integration
```

Des commandes ciblées existent : `test:integration:postgres`, `test:integration:scylla` et `test:integration:redis`. Commencer par les tests les plus proches du changement, puis élargir selon le risque. Ne pas annoncer que la suite est verte sans l'avoir exécutée dans l'état courant du dépôt.

## État connu et priorités

Au 4 septembre 2026, les migrations jusqu’à `014_sweego_delivery_tracking` sont cataloguées et appliquées localement ; consulter `docs/roadmap.md` pour les bilans validés et `test.md` pour les procédures. L’intégration PostgreSQL couvre notamment le rejeu/conflit/consommation photo, les reprises/dead letters de l’outbox, les notifications transactionnelles et reprises par appareil, l’effacement concurrent des notifications et les alertes Stripe obsolètes, les décisions opérateur auditées, la suppression en cascade des réponses, la revue photo et l’invalidation d’une session quand sa passkey est révoquée. R02 ajoute 26 scénarios d’effacement avec checkpoints perdus, écritures tardives, upload en cours, verrouillage et reprise auditée. `docs/sql-performance.md` décrit l’audit des requêtes et les plans mesurés.

Le socle fonctionnel P0/P1 et le stockage photo privé sont présents. SeaweedFS `weed mini` sert au développement sur une machine ; avant la production, il faut choisir et éprouver une cible S3-compatible durable, hautement disponible, sauvegardée et supervisée.

Le backlog détaillé et ses critères de validation sont centralisés dans `docs/roadmap.md`. R01 (notifications durables), R02 (effacement reprenable et suivi dashboard) et R03 (concurrence/pannes) sont livrés. R04 ajoute le suivi Sweego, les callbacks signés et les reprises sans renvoi ; son bilan reste dans la roadmap. Le prochain lot API conseillé est la réconciliation Stripe, dont les créations Customer incertaines trop anciennes. Le bornage des traitements, les exports et les logs restent à consolider. Avant production, terminer également calibration/recours de modération, alertes/supervision, sauvegardes/restaurations, exploitation WebAuthn, charge et audit indépendant. Mettre à jour la feuille de route après chaque lot validé plutôt que dupliquer son inventaire ici.

La migration `010_mobile_refresh_sessions` ajoute les familles et la filiation des refresh, les liens d'appareils push et l'effacement des sessions mobiles ; elle est incompatible avec les écritures de l'ancien code sans `family_id`. Les tests PostgreSQL réels couvrent rotation, rejeu, concurrence, logout, révocation, bannissement, rétention et migration des tokens historiques.

La migration `011_durable_notifications` ajoute la déduplication des notifications et les références de livraison par appareil ; `012_notification_eligibility` ajoute le contexte interne de facturation et le nettoyage final des notifications lors de la désactivation. `013_resumable_account_erasure` ajoute les étapes RGPD et intentions Customer. `014_sweego_delivery_tracking` distingue l’acceptation HTTP du callback d’envoi, ordonne les tentatives et conserve leurs délais sans allonger leur rétention. Toute évolution persistante suivante exige une migration après 014. Arrêter les anciens écrivains et déployer API et workers compatibles ensemble : un ancien worker ne connaît pas les nouveaux événements ou ignore leurs contrôles. Les références sont effacées avec notification/appareil/événement purgé ; ne pas copier les tokens FCM dans l’outbox ni prolonger les rétentions existantes.

R03 couvre continuation/quota Free, tombstones, retrait concurrent des consentements, pagination matchs/signalements, maintenances sur données expirées, coupures Redis/Scylla/S3 et arrêts réels du worker d’effacement. R04 vérifie aussi les issues SMS, les callbacks et les pertes de réponse avec PostgreSQL et un serveur HTTP local. Restent à éprouver la destination Sweego réelle et ses retries, un parcours Stripe sandbox complet, les volumes, les pannes de l’hôte et les restaurations sur la cible de production ; les tests locaux ne remplacent pas ces validations.

Les validations juridiques/DPO, l'AIPD, les comptes inactifs, les sous-traitants/transferts et les règles de sauvegarde ne sont pas des décisions à inventer dans le code. Les signaler comme dépendances lorsqu'une tâche les touche.

## Discipline de modification

- Préserver les changements utilisateur déjà présents dans le worktree et ne jamais écraser un fichier modifié sans avoir inspecté son diff.
- Ajouter ou adapter les tests au niveau approprié : unitaire pour les règles isolées, e2e pour le contrat Fastify, intégration pour le SQL/CQL et la concurrence réels.
- Toute nouvelle route doit avoir validation DTO, erreurs stables, authentification/autorisation explicite, rate limit adapté, documentation dans `routes.md` et tests de contrat.
- Les tableaux de `routes.md` portent les chemins complets (`/api` inclus), une seule ligne par méthode/chemin. Le test `routes-documentation.contract.spec.ts` compare cet inventaire au graphe Nest/Fastify réel ; ne pas le remplacer par une liste de contrôleurs maintenue à la main. Il ne vérifie pas les schémas JSON ni les autorisations.
- Toute mutation pouvant être rejouée par le mobile ou un fournisseur doit définir son comportement d'idempotence.
- Maintenir la pagination par curseur pour les grandes listes ; `offset` n'est conservé que pour compatibilité et est déprécié.
- Ne pas ajouter de workflow CI sans demande explicite : la validation complète est actuellement locale.
