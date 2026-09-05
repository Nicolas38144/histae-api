# Histae API — guide de validation

Ce guide explique **quoi exécuter, avec quels prérequis et quelles limites**. Il ne sert ni de catalogue des
scénarios ni de journal de livraison : les fichiers de test font foi pour les cas détaillés, la sortie Jest pour
les nombres, et la [roadmap](docs/roadmap.md) pour le bilan synthétique.

## Choisir le bon niveau

| Niveau | Ce qu’il vérifie | Infrastructure |
| --- | --- | --- |
| `test/unit/` | Règles isolées, validation, mappers, cas d’échec et sécurité des helpers. | Aucune ; dépendances contrôlées. |
| `test/e2e/` | Routes Fastify, corps, statuts, erreurs et autorisations selon la suite. | Aucune ; services/stockages remplacés par des doublures. |
| `test/integration/` | SQL/CQL, contraintes, transactions, verrous, concurrence et reprises réelles. | Stockages locaux de développement. |

Les helpers et processus de test sont dans `test/helpers/`, les images dans `test/fixtures/photos/`.
Jest ne découvre que `test/**/*.spec.ts`. Le contrôle `test-layout.spec.ts` refuse les tests hors de ce dossier.
Un test e2e utilisant un guard simulé ne prouve pas à lui seul que l’authentification réelle est correcte.

## Validation autonome

Prérequis : Node.js 22+, pnpm dans la version déclarée par `packageManager`, dépendances installées.
Depuis la racine de l’API :

```powershell
pnpm install --frozen-lockfile
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm test
```

`pnpm test` regroupe les suites unitaires et e2e, sans les intégrations. Inutile de le précéder systématiquement
des deux commandes séparées. Pour cibler un niveau ou une régression :

```powershell
pnpm run test:unit
pnpm run test:e2e
pnpm exec jest --runInBand --testPathPatterns=test/e2e/routes-documentation.contract.spec.ts
pnpm run test:watch
```

Les tests autonomes ne doivent dépendre ni des secrets du développeur ni de conteneurs disponibles.
Les échecs fournisseur simulés peuvent produire des logs attendus ; juger le résultat Jest et le code de sortie,
pas la seule présence d’une ligne ERROR.

`logging-policy.spec.ts` inspecte statiquement `src/` et `scripts/` : il refuse les stacks, les sorties d’erreur
directes et les appels au logger qui ne passent pas par un code ou un formateur sûr. Les valeurs interdites sont
également exercées par `safe-logging.spec.ts`. Voir [la politique de journalisation](docs/logging-policy.md).

## Validation avec les stockages locaux

Préparer les services décrits dans le [README](README.md), puis vérifier la cible de `.env` avant les migrations.
Ne jamais afficher ce fichier ou ses secrets dans les sorties de test.

| Service | Prérequis / périmètre autorisé |
| --- | --- |
| PostgreSQL | `ENV=development`, base locale `histae-dev`, migrations appliquées. |
| ScyllaDB | Activé, keyspace local `histae_discovery` migré ; mono-nœud sans TLS pour la suite de coupures réseau. |
| Redis | Local ; tests dédiés exclusivement dans la base logique 15. |
| S3 compatible | Bucket local préparé ; endpoint HTTP loopback pour les tests de panne. SeaweedFS `weed mini` convient en développement. |

Stripe n’est jamais appelé par la suite automatisée. `postgres.billing-reconciliation.integration.spec.ts`
vérifie dans un schéma isolé la planification outbox, la récupération d’une intention, l’arrêt entre persistance et
rattachement du Customer, la barrière anti-doublon et le refus d’écraser une projection plus récente. Le parcours
réel reste un contrôle sandbox séparé.

```powershell
pnpm run db:migrate
pnpm run scylla:migrate
pnpm run test:integration
```

Les suites réelles sont activées directement, sans flag de contournement. Une dépendance indisponible est un
échec à diagnostiquer, pas une raison de désactiver silencieusement les tests. Aucun reset n’est nécessaire.
La commande complète lance PostgreSQL, Scylla, Redis puis les coupures réseau dans quatre processus Jest successifs :
les connexions et pilotes natifs sont ainsi libérés entre groupes, sans réduire la couverture.

Commandes ciblées :

```powershell
pnpm run test:integration:postgres
pnpm run test:integration:scylla
pnpm run test:integration:redis
pnpm run test:integration:network
pnpm exec jest --runInBand --testPathPatterns='postgres.business-concurrency|postgres.crash-recovery|network-recovery'
```

La suite PostgreSQL de démarrage initialise aussi le graphe Nest : Redis doit être disponible selon la
configuration. La suite d’intégration Scylla utilise aussi PostgreSQL. L’analyseur photo local n’est pas requis par
ces suites ; il est nécessaire pour un smoke test manuel du parcours photo avec analyse automatique activée.

### Isolation et nettoyage

- Utiliser des UUID temporaires, transactions annulées ou schémas dédiés ; ne pas consommer les jobs du développeur.
- Les fixtures de résilience rejouent les migrations dans `r03_test_<uuid>`, vérifient leur schéma et ne suppriment que celui créé.
- Ne jamais exécuter de nettoyage global du schéma public, de Redis, du keyspace Scylla ou du bucket.
- Les compteurs Redis uniques expirent en deux secondes dans la suite dédiée, trente secondes dans la suite réseau.
- Les scénarios Scylla/S3 nettoient leurs propres UUID et objets ; ne pas supprimer des références inconnues après un échec.
- Injecter les pannes seulement dans les relais TCP loopback et processus enfants créés par la suite. Ne pas arrêter
  les conteneurs partagés ni tuer un processus à partir de son seul nom.
- Fermer clients, pools et processus même après assertion échouée. Ne pas ajouter `forceExit` pour masquer une fuite.

Le correctif pnpm de `cassandra-driver@4.9.0` fait partie de la validation de reconnexion :
conserver `patches/` et les fichiers pnpm ensemble. Protocole complet : [tests de résilience](docs/resilience-tests.md).

## Contrôle de la documentation HTTP

`test/e2e/routes-documentation.contract.spec.ts` démarre le vrai graphe `AppModule` dans Nest/Fastify,
sans connexion externe ni écoute réseau. Il compare les couples **méthode + chemin complet** enregistrés aux
lignes des tableaux de [routes.md](routes.md) et refuse les oublis, entrées obsolètes, doublons et lignes mal formées.

Les routes SSE sont incluses. Les alias HEAD automatiques sont désactivés dans cette fixture ; une route HEAD
applicative explicite reste vérifiée. Le preflight CORS généré par l’adaptateur n’appartient pas à l’inventaire métier.
Ce test ne valide pas les corps, exemples JSON ou permissions documentés : les tests de contrat dédiés restent indispensables.

## Photos et fournisseurs

`test/fixtures/photos/` couvre les six extensions admises. `pnpm run fixtures:photos` régénère JPG/JPEG/PNG/WebP
et la copie HEIF ; conserver la fixture HEIC réelle. Un test de transport S3 avec un objet temporaire ne remplace
pas un test de décodage/conversion, de modération ou de contrôle d’accès à une photo.

Les suites automatisées n’appellent pas Sweego, Stripe ou FCM. Les signatures Stripe sont vérifiées avec des
secrets factices et les réponses fournisseur sont contrôlées. Les tests d’arrêt du worker et les coupures réseau
réelles constituent deux scénarios distincts ; ils ne prouvent pas une transaction distribuée.

Pour un parcours Stripe manuel, utiliser uniquement une sandbox, ses clés de test et les Products/Prices Histae.
Stripe CLI peut relayer vers `/api/billing/stripe/webhook` ; utiliser le secret de signature de cette session,
ouvrir le Checkout créé par l’API puis vérifier l’abonnement et le portail. Retarder ensuite le webhook, exécuter
`maintenance:run` puis `outbox:work`, et contrôler la convergence via la route admin. Un événement générique de
`stripe trigger` ne garantit pas les métadonnées et prix requis par Histae. Ne jamais modifier une base partagée
ou employer une clé live pour ce parcours. Les scénarios SCA, renouvellement, annulation et remboursement restant
à exécuter sont suivis dans la [section Stripe de la roadmap](docs/roadmap.md#r05-stripe).

## Avant livraison et limites

1. Adapter les tests au changement : unitaire pour une règle, e2e pour un contrat, intégration pour un invariant en base.
2. Exécuter les contrôles autonomes ; ajouter les intégrations dès qu’un stockage, verrou, migration ou reprise est touché.
3. Vérifier le code de sortie et l’absence de ressource ouverte ; reporter le dernier bilan synthétique dans la roadmap.
4. Mettre à jour `routes.md` si le contrat change, et les guides concernés si les prérequis ou garanties évoluent.

Le passage des tests ne démontre pas un parcours mobile réel, la livraison effective d’un SMS/push, la
convergence d’une sandbox Stripe complète, la tenue en charge, la restauration après perte de machine ou
l’absence de vulnérabilité. Ces travaux restent dans la [roadmap](docs/roadmap.md), pas dans un inventaire parallèle ici.

Guides spécialisés :

- [Sessions mobiles et rotation](docs/mobile-sessions.md)
- [Notifications durables](docs/durable-notifications.md)
- [Effacement reprenable](docs/account-erasure.md)
- [Réconciliation Stripe](docs/stripe-reconciliation.md)
- [Concurrence et pannes locales](docs/resilience-tests.md)
- [Callbacks et reprises OTP Sweego](docs/sweego-delivery.md) : signatures/réponses synthétiques, PostgreSQL isolé, aucun SMS réel.
- [Baseline PostgreSQL](docs/postgres-migrations.md) : initialisation, checksums, reset local protégé et évolutions suivantes.
- [Politique de rétention](docs/retention-policy.md)
- [Portée des contrôles de sécurité](docs/roadmap.md#r12-securite)
