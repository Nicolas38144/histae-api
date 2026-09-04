# Notifications durables

Ce guide décrit la persistance des notifications, leurs intentions de push, les reprises et leurs limites.
Le contrat HTTP reste dans [routes.md](../routes.md), les commandes de validation dans [test.md](../test.md)
et les travaux ouverts dans la [roadmap](roadmap.md).

## Garanties et périmètre

Les notifications `new_match`, `new_message`, `billing_payment_failed` et `subscription_trial_ending`
sont enregistrées dans la transaction métier avec leurs intentions de push. Un rollback annule les deux ;
un arrêt après commit ne perd pas la programmation. Aucun broker supplémentaire n’est utilisé.

- Match : une notification par participant lors de la création effective.
- Message : une notification pour le destinataire seulement, jamais pour un rejeu idempotent.
- Stripe : notification, projection et marque de déduplication du webhook dans la même transaction.
- Chaque appareil enregistré au moment de la mutation reçoit une tâche distincte `notification.push`.
  Un appareil enregistré ultérieurement ne reçoit pas rétroactivement ces notifications.
- SSE reste un signal de rafraîchissement best-effort après commit, sans replay hors ligne.
  Le mobile doit relire les ressources métier à la reconnexion et au retour au premier plan.

La garantie porte sur l’intention durable et les reprises, **pas sur une livraison externe exactement une fois**.
Une réponse FCM perdue, ou un arrêt après acceptation mais avant acquittement PostgreSQL, peut provoquer un nouvel
envoi. Le même `notification_id` est transmis à chaque tentative et sur chaque appareil du destinataire. Le mobile
peut l’utiliser pour dédupliquer ; la déduplication visuelle d’une notification système déjà affichée dépend aussi
du client et de la plateforme. L’acceptation FCM ne prouve pas la réception par le téléphone.

## Stockage et responsabilités

`notification-outbox.ts` reçoit la transaction de l’appelant. Une seule instruction SQL crée :

1. `notification`, avec une clé de déduplication SHA-256 calculée sur type/source/destinataire ;
2. un événement `outbox_event` par appareil, avec un payload vide ;
3. `notification_push_delivery`, qui relie événement, notification, appareil et session au moment de la programmation.

Un conflit sur la clé ne recrée ni notification ni tâche. Les protections source restent indispensables : unicité
des matchs, idempotence des messages et déduplication Stripe. Le compte destinataire est verrouillé en lecture
partagée pendant la programmation, sans réseau. Le schéma ajoute un nettoyage des notifications après
la désactivation du compte, alors que son verrou exclusif est détenu : les écritures intercalées après le premier
nettoyage de `fct_anonymize_user` disparaissent dans la même transaction. Un écrivain attendant la désactivation
relit le compte et ne crée rien. Cela ne change pas l’ordre des verrous du flux d’effacement existant et ne prétend
pas résoudre à lui seul les étapes externes de l’effacement ni la concurrence des autres ressources métier.

Pour Stripe, `billing_reference` identifie en interne la facture ou l’abonnement ; `billing_trial_ends_at` fixe
la fin d’essai visée. Ces champs suivent la rétention de la notification et ne sont jamais copiés dans son
payload public, dans les événements outbox ou dans FCM. La programmation et le worker réutilisent le même
prédicat SQL de pertinence, défini dans `notification-billing.ts`.

`NotificationPushRepository` relit l’éligibilité ; `NotificationPushService` construit une allowlist de métadonnées ;
`PushService` effectue un seul envoi. `MobileDeliveryService` ne traite plus que SSE. Aucun token FCM n’est recopié
dans les tâches. Aucun texte privé ni objet Stripe brut n’est persisté dans la notification ou transmis au push.

## Reprises et annulations

Le worker conserve les lots de 50, au plus 5 handlers concurrents, les délais réseau bornés, le backoff exponentiel
plafonné à 60 secondes et le budget de 10 tentatives avant dead letter. Il renouvelle et revérifie la propriété de
chaque tâche avant traitement. Un claim abandonné redevient récupérable après le délai de 5 minutes existant.

Un appareil déjà acquitté n’est pas réessayé parce qu’un autre a échoué. Un appareil révoqué, réaffecté ou associé
à une autre session ne reçoit pas une ancienne tâche. Sont également ignorés : compte effacé/banni, session
expirée/révoquée, notification expirée/lue, match absent/terminé/expiré/bloqué, participant effacé/banni et message
absent ou déjà lu. Ces contrôles précèdent le réseau ; ils ne peuvent pas annuler un push déjà en vol ou reçu.

Les alertes Stripe sont filtrées à la programmation puis avant envoi : la facture doit toujours appartenir
au destinataire, être ouverte et présenter un solde restant ; l’abonnement Stripe doit être encore en essai,
avec le même identifiant et la même fin d’essai future. Un paiement, une activation, une prolongation ou une
expiration entre programmation et envoi rend la tâche inopérante. Une ancienne notification sans contexte
vérifiable reste conservée selon sa rétention, mais ne provoque pas de push. Les vérifications utilisent les
projections locales : elles ne compensent pas un webhook Stripe jamais reçu. La réconciliation correspondante
reste suivie dans la [roadmap](roadmap.md#r05-stripe).

Une tâche inéligible est acquittée sans réseau. Un `UNREGISTERED` explicite supprime le token et termine la tâche ;
un simple `404` ne suffit pas. Les autres erreurs FCM/OAuth/réseau remontent sous `push_delivery_unavailable`,
sans réponse fournisseur brute, token ou assertion dans les logs.

Avec `PUSH_PROVIDER=disabled`, les notifications restent persistées mais les tâches consommées sont acquittées
sans réseau. Réactiver FCM ne rejoue pas ces tâches. Sans worker actif, les tâches restent en attente.

## Exploitation et conservation

Les routes administratives existantes suffisent :

- `/api/admin/metrics` : `operations.outbox.notification_push` expose `pending`, `processing`, `completed`,
  `dead_letter`, `discarded`, `oldest_pending_at`, sans identifiant personnel. `completed` compte les tâches
  acquittées encore conservées, y compris celles devenues inéligibles, pas les réceptions FCM.
- `/api/admin/outbox/dead-letters` : type, tentatives et code normalisé, sans contenu, agrégat, appareil ou token.
- `/api/admin/outbox/:id/retry` et `/discard` : authentification récente, motif et audit transactionnel.
  Abandonner un push ne supprime pas la notification. La protection de `photo.delete` est inchangée.

Les durées restent celles de la [politique de rétention](retention-policy.md) : notification 90 jours par défaut,
événement résolu 7 jours, audit opérateur 1 an. Les références de livraison disparaissent en cascade avec
l’événement purgé, la notification ou l’appareil. Une dead letter dont la référence a disparu ne peut pas
reconstruire le contenu ; sa relance devient un no-op acquitté.

Le nettoyage du worker continu est actuellement plafonné à 50 événements par heure. La rétention de 7 jours est
le seuil d’éligibilité à la purge, pas une garantie de délai effectif si le stock croît plus vite. Le bornage est
suivi dans la [roadmap](roadmap.md#r06-volumes).

## Déploiement et validation

Appliquer la [baseline PostgreSQL courante](postgres-migrations.md), puis déployer ensemble des versions API et
worker compatibles avec `notification.push`. Ne pas laisser une version incompatible consommer ce type ou ignorer
ses contrôles. Une migration ordinaire ne rejoue aucune notification existante.

En développement, `MAINTENANCE_MODE=api` lance le worker intégré. Sinon, garder un processus
`MAINTENANCE_MODE=worker pnpm run outbox:work` actif. La configuration FCM doit être présente dans ce worker.

Les tests FCM simulent les réponses réseau : aucun push réel n’est envoyé. Les tests PostgreSQL des notifications
appliquent les migrations dans un schéma temporaire isolé, puis couvrent rollback, rejeu concurrent, reprise des
claims, échecs par appareil, frontière envoi/acquittement, autorisations, effacement concurrent dans les deux
ordres, alertes Stripe tardives ou devenues obsolètes, expiration, métriques et actions administratives.
Les commandes et prérequis sont décrits dans [test.md](../test.md) ; le dernier bilan synthétique est dans la
[roadmap](roadmap.md).
