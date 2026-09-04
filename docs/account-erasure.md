# Effacement de compte reprenable — R02

## Acceptation et contrat

`POST /api/users/me/deletion-token` conserve son jeton dédié à usage unique. `DELETE /api/users/me` le consomme
dans la transaction qui crée/récupère la demande RGPD, ajoute `account_erasure` et l’événement `account.erase`,
puis désactive le compte. La réponse est désormais **202** : `{ "request_id": "uuid", "status": "in_progress" }`.
Elle confirme l’enregistrement durable, pas l’effacement déjà terminé. Un échec de cette transaction ne consomme
pas le jeton. Les sessions mobiles et appareils sont invalidés par les mécanismes existants ; les JWT et
sessions admin ne donnent plus accès à ce compte. Le feed et les conversations ne le présentent plus.

Le mobile doit fermer sa session après acceptation. Si la réponse est perdue, la tâche reste durable et le compte
désactivé refuse les requêtes suivantes ; le même ancien JWT ne permet pas d’interroger son avancement. Aucun
endpoint public de suivi par UUID n’est ajouté. Le support dispose du suivi administratif.

Créer une DSR de type `erasure` ne désactive pas automatiquement le compte : cette demande suit la prise en
charge administrative habituelle. Pour une demande `in_progress`, le PATCH admin `status: completed` lance le
workflow et répond `200 { "message": "account erasure scheduled" }`, en conservant son état `in_progress`.
Le rejeu est sans nouvel effet ; un effacement commencé ne peut plus être refusé ou annulé. Les transitions
administratives exigent maintenant une authentification WebAuthn récente en plus de la session et de l’origine.

## Ordre des étapes

| Étape persistée | Travail et reprise |
| --- | --- |
| `stripe` | Supprimer le Customer connu et les créations de Customer suivies, par lots de 50. Une réponse perdue conserve l’intention ou l’identifiant nécessaire au rejeu. |
| `photos` | Passer au plus 50 lignes à `deleting`, supprimer chaque objet puis sa trace PostgreSQL seulement après confirmation. Rejouer un DELETE absent est sans effet. |
| `scylla` | Parcourir les 32 partitions acteur puis les 32 partitions cible. Traiter au plus 100 références par lot, supprimer d’abord la contrepartie puis la référence source. Une partition pleine est reprise, pas considérée terminée. |
| `postgres` | Dans une transaction locale, vérifier l’absence de photos, supprimer les références d’upload et credentials/sessions admin, exécuter l’anonymisation existante puis terminer DSR et workflow. Les factures conservées sont détachées selon les règles existantes. |
| `completed` | Aucun nouvel effacement : un acquittement outbox perdu est rejoué sans réanonymiser ni dupliquer l’audit. |

Les appels fournisseur ne s’exécutent pas dans une transaction PostgreSQL. Le worker outbox conserve ses lots,
sa concurrence, ses verrous de revendication et ses dix tentatives avant dead letter. Une étape réussie remet
le budget de tentatives à zéro et programme le lot suivant ; un verrou d’activité occupé diffère le travail de
cinq secondes sans consommer ce budget. Les erreurs persistées sont normalisées (`erasure_stripe_unavailable`,
`erasure_photos_unavailable`, `erasure_scylla_unavailable`, `erasure_postgres_unavailable`) et ne contiennent ni
réponse fournisseur, ni texte privé, ni clé objet. Désactiver Scylla n’équivaut pas à confirmer son nettoyage.

## Concurrence

`AccountActivityService` utilise des verrous consultatifs PostgreSQL **de session**, sans transaction SQL
ouverte pendant le réseau. Les uploads photo, créations Checkout et écritures de swipe prennent un verrou
partagé sur les comptes concernés, dans l’ordre de leurs UUID. Chaque étape d’effacement exige le verrou
exclusif du compte et attend donc la fin des écritures externes en cours. Le compte est désactivé dès
l’acceptation : les nouveaux écrivains sont refusés. Une perte de la connexion du verrou empêche de poursuivre
les écritures suivantes ou d’enregistrer un checkpoint comme réussi.

Un pool dédié de **4 connexions maximum par processus** évite qu’un écrivain bloque le pool transactionnel dont
il a lui-même besoin. Prévoir ces connexions dans le dimensionnement PostgreSQL. Ce mécanisme exige des sessions
PostgreSQL stables : accès direct ou pooling de session, pas de pooling transactionnel pour ce pool.

Des triggers `fct_require_live_account` / `fct_require_live_match` sérialisent les écritures métier locales
avec la désactivation. Ils refusent une écriture tardive avec `409 account_unavailable`. Les suppressions,
redactions et nettoyages de rétention restent possibles. La dernière transaction d’effacement verrouille les
matchs avant le compte, conformément à l’ordre de la messagerie. Les webhooks Stripe acquittent les événements
d’un compte désactivé sans recréer ses projections.

Cela ne crée pas une transaction distribuée. Un fournisseur qui termine arbitrairement tard une opération après
une perte de processus/connexion ne fournit pas, à lui seul, une preuve d’absence définitive. Les traces
techniques conservées, les deadlines des clients et la réconciliation demeurent nécessaires. R03 teste des arrêts
réels du worker aux checkpoints et la perte de sa connexion de verrouillage, ainsi que des coupures réseau locales
Scylla/S3. Les interruptions de l’hôte complet, restaurations et la cible S3 de production restent R10.
Voir [les scénarios, leur isolation et leurs limites](resilience-tests.md).

## Issue incertaine Stripe

La migration 013 conserve l’intention avant le POST Customer : `customer_creation_started_at`, puis
`created_customer_id` lorsqu’il est connu et `customer_erased_at` après suppression confirmée, dans la tentative
Checkout existante. Aucune clé secrète ni réponse Stripe n’y est copiée. Ces colonnes disparaissent avec les
tentatives lors de l’anonymisation, sans nouvelle durée de conservation.

Si la réponse de création s’est perdue, le worker peut rejouer exactement le POST et sa clé d’origine pendant
23 heures, puis supprimer le Customer retrouvé. La marge précède le minimum de 24 heures de conservation des
clés indiqué par [Stripe](https://docs.stripe.com/api/idempotent_requests). Une clé trop ancienne pourrait créer
un autre Customer : dans ce cas, le code refuse le rejeu avec `erasure_stripe_reconciliation_required` et ne
déclare pas la demande achevée. Un identifiant déjà connu reste supprimable après cette fenêtre. Les DELETE
sont intrinsèquement idempotents ; la clé passée par l’adaptateur n’ajoute pas de garantie. Les erreurs fournisseur
ne sont pas assimilées aveuglément à « déjà supprimé » : après un DELETE en erreur, un GET doit confirmer le même
identifiant et le marqueur `deleted: true` documenté par [Stripe](https://docs.stripe.com/api/customers/delete).

Ce cas requiert un diagnostic fournisseur et une procédure de réconciliation contrôlée (R05), pas un changement
manuel de l’étape vers `completed`. Les opérations historiques antérieures à 013 sans intention persistée
doivent aussi être vérifiées lors du déploiement ; cette migration ne peut pas reconstruire une réponse perdue.

## Exploitation et suivi admin

- Déployer la migration **013** puis API et workers compatibles ensemble, après arrêt des anciens écrivains.
  Ne pas laisser un ancien worker consommer `account.erase` ni un ancien écrivain contourner les verrous.
- En développement, `MAINTENANCE_MODE=api` suffit. En mode séparé, conserver `pnpm run outbox:work` actif avec la
  même configuration PostgreSQL, Scylla, S3 et Stripe que l’API. Aucun composant supplémentaire n’est nécessaire.
- `GET /api/admin/data-subject-requests` fournit un objet `erasure` nullable : étape, progression Scylla, dernier
  checkpoint, état outbox, tentatives, code d’erreur et UUID de tâche. Ni payload, ni référence Stripe, ni objet S3.
- Le dashboard affiche ce suivi et un bouton d’actualisation. Une dead letter propose « Reprendre » avec motif
  de 3 à 500 caractères via `POST /api/admin/outbox/:id/retry` : authentification récente et audit transactionnel
  existants. L’abandon d’un `account.erase` est toujours interdit, même si une étape semble déjà réussie.
- Les métriques outbox globales et le suivi de maintenance existants incluent ces tâches ; le raccordement aux
  alertes de production reste R08. Après la purge normale de l’événement résolu, le checkpoint `completed` reste
  visible avec sa DSR et un `event_id` nul.

Le checkpoint est supprimé par cascade avec la demande RGPD, selon sa rétention existante de cinq ans après
clôture. Une demande en échec n’est pas purgée comme si elle était terminée. Les autres rétentions ne changent pas.

## Validation

`postgres.erasure.integration.spec.ts` utilise un schéma temporaire local, de vrais verrous/transactions et des
fournisseurs simulés. Les tests ciblent l’acceptation atomique, la reprise après checkpoint/acquittement perdu,
le parcours complet, la conservation des traces S3, le refus des écritures tardives, l’exclusion publique, le
fencing des workers et la reprise administrative auditée. Les tests billing couvrent les réponses Stripe
perdues et la fenêtre d’idempotence ; les tests Scylla couvrent l’ordre des suppressions et les lots pleins.
Voir [test.md](../test.md) pour les validations réellement exécutées et les limites restantes.
