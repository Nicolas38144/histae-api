# Volumes, lots et export portable

Ce guide décrit les bornes d’exécution introduites par R06 et la méthode de calibration. Les valeurs par défaut
sont des budgets de sécurité initiaux, pas des objectifs de capacité universels.

## Maintenance des matchs

Une passe prend un verrou consultatif de session afin qu’un seul leader travaille à la fois, mais chaque lot est
validé dans sa propre transaction. Un arrêt libère automatiquement le verrou et la passe suivante reprend depuis
les états persistés dans `match_init`.

Chaque transaction traite au plus `MATCH_MAINTENANCE_BATCH_SIZE` lignes pour chacune des étapes suivantes :

1. `active` vers `awaiting_continuation` ;
2. `awaiting_continuation` vers `expired` ;
3. suppression des messages d’un match purgeable ;
4. détachement des signalements conservés ;
5. suppression des matchs sans enfant volumineux restant.

Les candidats utilisent les index de date et `FOR UPDATE SKIP LOCKED`. La suppression du parent n’entraîne donc
plus une cascade non bornée de messages ou de signalements. Une passe valide au plus
`MATCH_MAINTENANCE_MAX_BATCHES` transactions. Une valeur `work_remaining=true` dans
`operations.maintenance[matches]` indique que ce budget a été consommé et qu’une passe ultérieure doit continuer.
Les maintenances photo et rétention, déjà bornées, publient les mêmes champs de progression ; la purge des demandes
d’upload photo expirées avance désormais avec les autres lots au lieu de rester limitée à une seule requête.

## Purge de l’outbox

La rétention des événements `completed` ou `discarded` reste de sept jours. Toutes les heures, le worker supprime
jusqu’à `OUTBOX_PURGE_BATCH_SIZE` lignes par requête et `OUTBOX_PURGE_MAX_BATCHES` requêtes. Les valeurs par défaut
portent la capacité maximale d’une passe de 50 à 10 000 événements, tout en conservant des commits séparés et une
borne stricte. L’ancienneté et les états persistants de l’outbox permettent la reprise sans checkpoint additionnel.

## Collections administratives

Les demandes RGPD et le journal d’accès utilisent maintenant le même contrat que les autres grandes listes :
`limit`, curseur opaque `next_cursor`, ordre déterministe date/UUID et refus du mélange curseur/offset. Le curseur
conserve les microsecondes PostgreSQL ; le client ne doit ni le décoder ni le recréer à partir de la date affichée.
Le dashboard cumule ces pages et affiche aussi l’état, le nombre de lots et la reprise requise des maintenances.

## Export utilisateur

Le téléchargement reste un document JSON unique, mais il n’est plus assemblé intégralement en mémoire :

- les collections PostgreSQL sont lues par pages de `DATA_EXPORT_PAGE_SIZE` ;
- une transaction `REPEATABLE READ, READ ONLY` fournit un instantané cohérent pour toutes les données PostgreSQL ;
- les 32 partitions Scylla de décisions sortantes sont lues successivement avec pagination native ;
- le document est préparé dans un répertoire aléatoire du stockage temporaire de l’hôte, avec un fichier privé,
  puis transmis comme flux et supprimé dès la fermeture de ce flux ;
- aucune réponse partielle n’est envoyée si la préparation échoue ;
- `DATA_EXPORT_MAX_BYTES` borne l’espace occupé par une préparation. Au-delà, `413 data_export_too_large` impose
  un traitement hors ligne de la demande RGPD au lieu de dégrader l’API.
- `DATA_EXPORT_MAX_CONCURRENCY` borne par processus le nombre de fichiers en préparation ou en cours de réponse.
  Lorsque toutes les places sont occupées, `503 data_export_busy` demande au client de réessayer plus tard.

Il n’existe pas d’instantané atomique commun à PostgreSQL et ScyllaDB. Le bloc `consistency` du document expose donc
la date de l’instantané PostgreSQL et la fenêtre de lecture Scylla. `partitioned_live_read` signifie qu’un swipe
concurrent peut apparaître dans une partition et pas dans une autre. Cette limite est explicite ; l’export ne
communique toujours aucune décision entrante d’un tiers. Un arrêt brutal peut laisser un fichier orphelin : la
politique du répertoire temporaire de l’hôte doit le nettoyer au redémarrage ou périodiquement.

## Calibration

Avant de modifier un budget, observer sur un jeu représentatif :

- `operations.maintenance[*].processed_count`, `batch_count`, `duration_ms` et `work_remaining` ;
- `operations.runtime.memory_rss_bytes`, `heap_used_bytes` et le délai de boucle événementielle ;
- `operations.postgres_pool.waiting`, l’âge du plus ancien événement outbox et la fréquence des dead letters ;
- dans PostgreSQL, `pg_stat_activity.wait_event_type/wait_event` et les plans `EXPLAIN (ANALYZE, BUFFERS)` des
  requêtes concernées, uniquement sur un environnement de charge sans donnée de production.

Augmenter une seule borne à la fois, puis mesurer durée, mémoire, lignes traitées et contention. Réduire la taille
du lot si une transaction dépasse le budget de latence ou retarde les requêtes métier ; augmenter d’abord le nombre
maximal de lots si les transactions restent courtes mais que `work_remaining` persiste. La baseline PostgreSQL
définit les champs de progression et les index dédiés aux lectures d’export et au détachement des signalements.
`postgres.r06-volumes.integration.spec.ts` vérifie plusieurs pages, plus d’un millier d’événements
outbox et la reprise sur de petits lots ; ce garde-fou ne remplace pas une campagne de charge sur la cible finale.
