# Concurrence et reprises après panne

Ce guide décrit les scénarios de concurrence et de coupure exécutés sur les stockages locaux existants. Il ne
remplace ni une validation des fournisseurs réels ni un test de reprise après perte de machine. Les commandes
générales sont dans [test.md](../test.md) et le dernier bilan synthétique dans la [roadmap](roadmap.md).

## Scénarios

- `postgres.business-concurrency.integration.spec.ts` : continuations simultanées, dernière place du quota
  Free, quota nul, expiration pendant l’attente du verrou, tombstones, comptes bannis/désactivés, retraits de
  consentement dans les deux ordres de concurrence, curseurs avec égalités/microsecondes et maintenances concurrentes.
  Les purges conservent des lignes encore valides pour vérifier qu’elles ne suppriment pas trop largement.
- `postgres.crash-recovery.integration.spec.ts` : un vrai processus worker est arrêté avant les checkpoints
  Stripe, photos, swipes et PostgreSQL, puis après le commit final mais avant l’acquittement outbox. Le processus
  suivant termine la demande avec une seule trace d’anonymisation. Un autre cas coupe la connexion PostgreSQL qui
  porte le verrou de session et vérifie le refus de l’écriture externe suivante.
- `network-recovery.integration.spec.ts` : Redis refuse le rate limiting pendant sa déconnexion et retrouve
  le compteur après reprise ; une réponse S3 DELETE perdue après suppression réelle conserve la trace PostgreSQL
  jusqu’au retry réussi.

La création unique d’un match sur likes réciproques, les notifications durables et l’effacement reprenable sont
couverts par leurs suites d’intégration dédiées.

## Défauts corrigés

1. **Consentement vérifié trop tôt.** Un retrait pouvait se terminer après le précontrôle du service mais avant
   l’écriture du sexe, des préférences ou de la présence. Trois tests ont reproduit la réintroduction des données.
   Le repository verrouille maintenant le compte avant de relire les versions requises dans la transaction d’écriture,
   comme le retrait lui-même. Le service conserve le précontrôle et traduit le refus tardif en `403 required_consent_missing`.
2. **Horloge évaluée avant l’attente.** Une continuation ou un message pouvait passer après l’échéance en réutilisant
   l’heure évaluée avant `FOR UPDATE`. Deux tests ont reproduit ce cas. Une CTE matérialisée verrouille le match ;
   l’horloge est lue dans le SELECT extérieur, sans aller-retour SQL supplémentaire.
3. **Quota nul.** Le premier INSERT de consommation pouvait allouer une continuation malgré une limite configurée à
   zéro. Le prédicat s’applique maintenant aussi à l’insertion initiale ; une régression couvre cette configuration.
## Isolation et exécution

```powershell
pnpm install --frozen-lockfile
pnpm run test:integration

# Suites ciblées
pnpm exec jest --runInBand --testPathPatterns='postgres.business-concurrency|postgres.crash-recovery|network-recovery'
```

Prérequis : PostgreSQL `histae-dev` en développement, Redis local et bucket S3 local accessible en HTTP.
Les relais refusent une cible autre que `localhost`, `127.0.0.1` ou `::1`; le scénario Redis utilise
exclusivement la base logique 15.

Les fixtures initialisent la chaîne de migrations dans leurs schémas PostgreSQL aléatoires `r03_test_<uuid>`.
Elles vérifient le schéma avant nettoyage et ne suppriment que celui qu’elles ont créé. L’objet S3 utilise un UUID
propre au test ; son nettoyage est ciblé. Les compteurs Redis uniques expirent en 30 secondes.
La fixture S3 teste le transport et le cycle de suppression, pas la validité du contenu WebP.

Les coupures passent par des relais TCP loopback éphémères et touchent uniquement les connexions qu’ils ont ouvertes.
Les conteneurs partagés ne sont ni arrêtés ni réinitialisés. Seul le processus enfant créé par le test est tué ;
sa configuration PostgreSQL passe par IPC, jamais par les arguments, les logs ou un fichier de secrets.
La date de revendication outbox est vieillie uniquement dans le schéma de test pour accélérer la reprise.

## Limites conservées

Les étapes fournisseur du processus arrêté utilisent des réponses contrôlées ; les coupures réseau réelles sont
testées séparément. Ni Stripe, Sweego ni FCM ne sont appelés ; leurs validations réelles restent dans la
[roadmap](roadmap.md). Ces tests ne simulent pas une panne électrique de l’hôte, une perte de disque ou une
restauration de sauvegarde, ni la charge et les budgets de performance. Ils ne garantissent pas une transaction distribuée ni
l’absence d’une réponse arbitrairement tardive du fournisseur. Ils ne remplacent pas un audit de sécurité indépendant.
