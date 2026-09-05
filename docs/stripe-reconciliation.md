# Réconciliation Stripe durable

Ce guide décrit le filet de cohérence entre Stripe et la projection PostgreSQL. Les webhooks restent le chemin
rapide ; la réconciliation corrige un webhook perdu, retardé ou livré dans le désordre sans donner au dashboard
un accès direct au fournisseur.

## Événements et planification

Deux événements à payload vide réutilisent l’outbox commune :

- `billing.subscription.reconcile`, agrégé par UUID utilisateur ;
- `billing.customer.reconcile`, agrégé par UUID de tentative Checkout.

`BillingReconciliationService` programme au plus `STRIPE_RECONCILIATION_BATCH_SIZE` éléments par passage. En
développement, `MAINTENANCE_MODE=api` lance le timer intégré. En production, `maintenance:run` programme les
éléments et `outbox:work` les traite avec les mêmes leases, retries et dead letters que les autres effets durables.
La fréquence et la fraîcheur cible viennent de `STRIPE_RECONCILIATION_INTERVAL` et
`STRIPE_RECONCILIATION_FRESHNESS`.

Une erreur transitoire est réessayée au plus dix fois. Une ambiguïté de propriétaire, plusieurs abonnements Premium
courants ou une réponse structurellement inexploitable devient immédiatement une dead letter. Seul un code
normalisé est persisté ; aucune réponse Stripe, clé, Customer ID, Subscription ID ou moyen de paiement n’est copié
dans l’outbox.

## Projection des abonnements

Le worker prend le verrou d’activité partagé du compte, relit le Customer local, puis récupère chez Stripe le
Customer et ses abonnements. Il ne retient que le Product Premium configuré et refuse plus d’un abonnement courant.
Un Customer supprimé annule la projection et désactive sa relation locale ; l’absence d’abonnement Premium annule
uniquement une ancienne projection Stripe.

Chaque lecture externe mémorise son instant de départ. `user_subscription.projection_version` est relu avant le
réseau puis vérifié sous verrou au commit. `provider_snapshot_at` empêche ensuite un webhook antérieur à cette
lecture d’écraser le résultat. Si un webhook ou un autre worker gagne la course, le snapshot perdant n’écrit rien ;
le passage suivant repart du nouvel état.

## Création Customer incertaine

Avant le `POST /v1/customers`, Histae persiste `customer_creation_started_at` et programme dans la même transaction
un watchdog disponible 23 heures plus tard. Le Customer reçoit les métadonnées `histae_user_id` et
`histae_customer_attempt_id`.

Après la réponse Stripe, l’identifiant Customer est d’abord persisté sur la tentative. Le watchdog n’est supprimé
que dans la transaction qui rattache ensuite ce Customer au compte. Si le processus s’arrête entre les deux, la
maintenance remet immédiatement cette tentative en file et rattache l’identifiant déjà connu sans appel réseau.

Stripe conserve le résultat d’une clé d’idempotence pendant au moins 24 heures. Histae autorise donc le rejeu de la
même requête et de la même clé pendant 23 heures seulement ; l’heure de marge couvre latence et écarts d’horloge.
Après ce seuil, aucun `POST` n’est rejoué. Le worker recherche l’identifiant de tentative, puis utilise une fenêtre
de création stricte pour les anciennes tentatives dépourvues de cette métadonnée. Zéro résultat libère la tentative,
un résultat restaure la relation locale, et tout résultat ambigu exige une intervention. L’effacement de compte
reste bloqué tant que cette lecture sûre n’a pas résolu l’intention.

Tant qu’une création Customer reste incertaine, une nouvelle clé d’idempotence du même utilisateur est refusée par
`billing_customer_reconciliation_required`. Seule la clé d’origine peut rejouer la requête dans la fenêtre sûre ;
cette barrière couvre également l’arrêt entre persistance et rattachement, et évite qu’un retry applicatif crée
plusieurs Customers avec des clés Stripe différentes.

Référence fournisseur : [idempotence Stripe](https://docs.stripe.com/api/idempotent_requests) et
[recherche de Customers](https://docs.stripe.com/search).

## Exploitation administrative

`GET /api/admin/billing-reconciliation` expose seulement les dead letters exigeant une décision : UUID
d’événement/utilisateur, type, tentatives, code d’erreur et dates. La file normale n’est visible que sous forme de
métriques agrégées. Les événements sont remis en file par `POST /api/admin/outbox/:id/retry` : une session WebAuthn
récente, un motif et un audit transactionnel sont obligatoires. Leur abandon est interdit.

`GET /api/admin/metrics` expose `operations.outbox.billing_reconciliation` et la maintenance `billing`. Les alertes
externes sur âge, dead letters et retard restent à configurer dans R08.

## Validation fournisseur avant production

Les tests automatisés utilisent des réponses synthétiques et PostgreSQL isolé. Avec les clés de sandbox du projet,
vérifier encore : paiement avec authentification renforcée, renouvellement, annulation immédiate et en fin de
période, échec de paiement et remboursement. Pour chaque scénario, couper ou retarder le webhook, exécuter la
maintenance puis confirmer que la projection converge sans notification ou effet en double.
