# AGENTS.md — Histae API

Ces instructions s'appliquent à tout le dépôt `histae-api`.

## Contexte du projet

Histae API est le backend TypeScript de l'application mobile de rencontres Histae. Le projet utilise NestJS 11 avec Fastify 5 et expose ses routes métier sous `/api`. Les seules exceptions sont `/health/live` et `/health/ready`. L'API n'embarque ni OpenAPI ni Swagger ; `routes.md` est la référence du contrat HTTP.

Les sources de référence à consulter avant une modification importante sont :

- `resume.md` pour l'architecture, les règles métier, les risques ouverts et la feuille de route ;
- `routes.md` pour le contrat HTTP existant ;
- `test.md` pour l'inventaire des tests et la procédure de validation ;
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

## Invariants à préserver

- Les DTO refusent les champs inconnus. Ne pas accepter de champs de privilège ou d'identifiants/prix Stripe choisis par le client.
- Les erreurs publiques utilisent toujours `{ "error": { "code", "message" } }` et n'exposent aucune stack.
- Les réponses portent les en-têtes défensifs centralisés dans `common/http/http-lifecycle.ts`; ne pas les dupliquer dans les contrôleurs.
- Les dates de naissance sont des dates calendrier strictes `YYYY-MM-DD` et l'utilisateur doit avoir au moins 18 ans.
- Les téléphones sont actuellement limités au format français E.164. Ne jamais persister ni journaliser le numéro en clair.
- Les access tokens sont des JWT HS256 typés `access`. Les rôles et l'état du compte sont relus depuis PostgreSQL ; ne jamais faire confiance à un rôle fourni par le client ou par un ancien token.
- Les refresh tokens et les OTP sont rotatifs/à usage unique selon les transactions et verrous existants. Préserver l'idempotence des envois OTP.
- L’OTP/JWT authentifie le client mobile uniquement. Toute route administrative doit utiliser `AdminSessionGuard` et ne doit jamais accepter un JWT mobile, même pour un compte de rôle `admin`.
- L’authentification admin est WebAuthn native : vérification utilisateur et credential découvrable obligatoires, challenge et bootstrap à usage unique, origine/RP ID exacts, compteur vérifié, session opaque hashée en base et cookie `HttpOnly; SameSite=Strict`. Toute mutation admin doit refuser une origine différente de `ADMIN_WEBAUTHN_ORIGIN`.
- En développement WebAuthn utilise exclusivement `http://localhost:5173` avec le RP ID `localhost` et le proxy Vite `/api`; ne pas substituer `127.0.0.1`. En production, imposer HTTPS et le cookie `__Host-…; Secure`.
- La gestion des passkeys et des autres sessions exige une authentification récente. Ne jamais permettre de révoquer la passkey de la session courante, la dernière passkey active ou la session courante via la route de révocation ciblée. Les listes et historiques ne doivent exposer ni token/hash, ni clé publique.
- Les routes utilisateur normales exigent les CGU et la notice courantes. Les routes indispensables à l'onboarding, à la déconnexion et aux droits RGPD restent accessibles selon `routes.md`.
- Le sexe et les préférences exigent le consentement aux données sensibles ; la présence exige le consentement de localisation. Leur retrait doit déclencher l'effacement immédiat documenté.
- Les transitions de match, la continuation, les quotas, l'expiration et l'envoi idempotent des messages doivent rester atomiques.
- Une décision de swipe est immuable pendant sa rétention. Deux likes réciproques ne doivent créer qu'un match PostgreSQL, même en concurrence.
- Le texte privé d'un message ne doit être ni persisté dans une notification mobile ni transmis à FCM.
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
- Ne pas modifier les durées de rétention sans mettre à jour la politique, les migrations, la maintenance et les tests correspondants.
- Ne pas exposer de secret, `.env`, clé fournisseur, token FCM, téléphone ou justification sensible dans les logs ou les réponses.

## Base de données et migrations

- PostgreSQL utilise la baseline consolidée `001_baseline_20260901`, construite depuis `db/schema_postgres.sql` et `db/insert_postgres.sql`. Les quinze anciennes versions ne subsistent que comme identifiants de compatibilité dans `scripts/migration-catalog.ts`.
- Le schéma Scylla est dans `scylla/001_discovery.cql` et utilise deux vues orientées requêtes, sans index secondaire.
- Les migrations incrémentales `002_user_photo_lifecycle` à `009_sql_performance_indexes` ajoutent le cycle photo, l’idempotence/outbox, la réconciliation, les questions, la modération, WebAuthn admin, le suivi des maintenances/récupération auditée des dead letters puis les chemins d’index SQL. Après ces versions, ajouter une nouvelle migration pour toute évolution persistante. Ne pas modifier une migration déjà déployée sans stratégie explicite de checksum et de compatibilité.
- Les resets sont destructifs et réservés au développement local. `db:reset` doit rester limité à PostgreSQL local `histae-dev`; `db:reset-scylla` doit rester limité au keyspace local `histae_discovery`.
- Ne jamais lancer `DROP`, `TRUNCATE`, `ALTER TABLE` destructif ou un reset contre une cible non vérifiée. Les tests Scylla doivent utiliser des UUID temporaires et un nettoyage ciblé.
- Les tests d'intégration réels attendent PostgreSQL `histae-dev`, Scylla local et Redis local (base logique 15 pour la suite Redis). SeaweedFS local est requis pour la readiness complète et le smoke test photo.

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

Validation réelle, avec PostgreSQL, ScyllaDB et Redis locaux préparés :

```powershell
pnpm run test:integration
```

Des commandes ciblées existent : `test:integration:postgres`, `test:integration:scylla` et `test:integration:redis`. Commencer par les tests les plus proches du changement, puis élargir selon le risque. Ne pas annoncer que la suite est verte sans l'avoir exécutée dans l'état courant du dépôt.

## État connu et priorités

Au 3 septembre 2026, les migrations jusqu’à `009_sql_performance_indexes` sont cataloguées ; consulter `test.md` pour l’état exact de leur application et les validations réelles. L’intégration PostgreSQL couvre notamment le rejeu/conflit/consommation photo, les reprises/dead letters de l’outbox, les décisions opérateur transactionnelles/auditées, la suppression en cascade des réponses, la revue photo et l’invalidation d’une session quand sa passkey est révoquée. `docs/sql-performance.md` décrit l’audit des requêtes et les plans mesurés.

Le socle fonctionnel P0/P1 et le stockage photo privé sont présents. SeaweedFS `weed mini` sert au développement sur une machine ; avant la production, il faut choisir et éprouver une cible S3-compatible durable, hautement disponible, sauvegardée et supervisée.

Les prochains travaux API/infra prioritaires documentés sont :

1. suivi opérationnel de la livraison Sweego, idéalement par webhook, et gestion/test de la perte de réponse fournisseur ;
2. calibration sur un corpus représentatif, mesure des faux positifs/biais, élargissement documenté des catégories interdites et procédure d’appel de la modération ;
3. raccordement des métriques internes au système d’alertes de production et observation du feed hybride ;
4. déploiement/supervision des workers maintenance et outbox, avec Redis hautement disponible/managé dans l'environnement cible ;
5. sauvegarde/restauration PostgreSQL, du stockage objet et stratégie de sauvegarde, réparation et montée de version Scylla ;
6. réconciliation Stripe planifiée vers `user_subscription` et alerte sur les webhooks durablement en échec ;
7. tests de charge, audit de sécurité externe et rotation opérationnelle des secrets.

La couverture à étendre concerne notamment la concurrence de continuation/quota Free, les refresh tokens avec PostgreSQL réel, les tombstones, le retrait des consentements, la pagination matchs/signalements, la maintenance sur données expirées, les coupures Redis/Scylla, le webhook Sweego et un parcours Stripe sandbox complet.

Les validations juridiques/DPO, l'AIPD, les comptes inactifs, les sous-traitants/transferts et les règles de sauvegarde ne sont pas des décisions à inventer dans le code. Les signaler comme dépendances lorsqu'une tâche les touche.

## Discipline de modification

- Préserver les changements utilisateur déjà présents dans le worktree et ne jamais écraser un fichier modifié sans avoir inspecté son diff.
- Ajouter ou adapter les tests au niveau approprié : unitaire pour les règles isolées, e2e pour le contrat Fastify, intégration pour le SQL/CQL et la concurrence réels.
- Toute nouvelle route doit avoir validation DTO, erreurs stables, authentification/autorisation explicite, rate limit adapté, documentation dans `routes.md` et tests de contrat.
- Toute mutation pouvant être rejouée par le mobile ou un fournisseur doit définir son comportement d'idempotence.
- Maintenir la pagination par curseur pour les grandes listes ; `offset` n'est conservé que pour compatibilité et est déprécié.
- Ne pas ajouter de workflow CI sans demande explicite : la validation complète est actuellement locale.
