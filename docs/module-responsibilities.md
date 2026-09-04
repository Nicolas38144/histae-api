# Frontières de responsabilités

Ce document fixe les frontières internes à préserver lors d’un refactor. Il complète la vue d’ensemble de
[resume.md](../resume.md) sans recopier le contrat HTTP ni le backlog.

## Composants spécialisés

| Domaine | Composant | Responsabilité |
| --- | --- | --- |
| Auth mobile | `OtpService` / `OtpRepository` | Intentions d’envoi et erreurs publiques / états OTP, corrélation, activation et consommation sérialisées. `AuthRepository` ne conserve que les comptes. |
| SMS | `SweegoSmsService` / `SweegoWebhookService` | POST borné sans retry / signature brute, validation et projection minimale du callback. |
| Matchs | `MatchesRepository` | Création, listes et projections, révélation, continuation et quotas. |
| Matchs | `MatchMessageRepository` | Pagination des messages, envoi idempotent et accusés de lecture. |
| Matchs | `MatchMaintenanceRepository` | Élection transactionnelle du worker puis transitions et purge. Le timer et le suivi opérationnel restent dans `MatchMaintenanceService`. |
| Administration | `AdminRepository` | Recherche/détail des comptes, bannissement et accès audité aux conversations. |
| Administration | `AdminMetricsRepository` | Agrégats de consultation et estimation de revenu, sans mutation métier. |
| Administration | `AdminPhotoRepository` | Liste et remise en file des photos réconciliables, sans accès S3 ni signature d'URL. |
| Facturation | `BillingService` | Projection utilisateur, Checkout, portail et suppression du Customer pour l'effacement. |
| Facturation | `StripeWebhookService` | Vérification du webhook, mapping fournisseur, projection et notifications transactionnelles ; SSE après commit. |
| RGPD | `erasure-enqueue.ts` | Acceptation durable et désactivation dans la transaction de l’appelant, sans réseau. |
| RGPD | `ErasureRepository` / `ErasureService` | Checkpoints/finalisation transactionnels / enchaînement Stripe, photos, Scylla, PostgreSQL via l’outbox. |
| Concurrence | `AccountActivityService` | Verrous de session sur les écrivains externes et l’effacement, dans un pool dédié borné ; aucune transaction longue. |
| Mobile | `notification-outbox.ts` | Notifications et tâches par appareil dans la transaction métier de l’appelant. |
| Mobile | `NotificationPushRepository` / `NotificationPushService` | Éligibilité courante et métadonnées minimales avant envoi FCM. |
| Mobile | `MobileDeliveryService` / `PushService` | Signaux SSE best-effort / envoi vers un seul appareil avec erreurs normalisées. |

Les modules Nest injectent directement ces composants. Il n'existe pas de façade de repository qui recrée ses
dépendances avec `new` ou conserve une copie des anciennes méthodes. Les contrôleurs gardent leurs guards,
validations et limites de débit. Les transitions RGPD exigent une authentification récente ; le dashboard suit
leur progression et les reprises, sans piloter directement les étapes internes.

## Frontières transactionnelles à conserver

- Les écritures OTP prennent le verrou du téléphone pseudonymisé avant les lignes. Aucun réseau sous verrou.
  Un callback tardif ne réactive jamais un ancêtre consommé/remplacé ; un échec de persistance après envoi reste
  incertain. Les métadonnées de livraison restent dans la rétention OTP existante. Voir [suivi Sweego](sweego-delivery.md).

- `match-access.ts` reçoit le `PoolClient` de l'appelant. Révélation et messagerie partagent ainsi les mêmes
  contrôles de participation, verrouillage et expiration ; l'utilitaire ne démarre pas une autre transaction.
- L’horloge des matchs est lue après acquisition du verrou, dans le SELECT extérieur à une CTE matérialisée.
  Une heure calculée avant l’attente de `FOR UPDATE` ne doit pas prolonger la fenêtre métier.
- `UsersRepository` verrouille le compte et relit les versions des consentements dans la transaction qui écrit
  profil, préférences ou présence. `UsersService` fournit les versions configurées et traduit le refus en erreur
  publique stable ; son précontrôle seul n’autorise pas une écriture après retrait concurrent.
- `matches.constants.ts` porte la durée de purge déjà existante, sans changement de rétention.
- `admin-audit.ts` reçoit la transaction de la consultation ou mutation protégée. La réconciliation photo
  conserve dans ce même commit le passage à `deleting`, la remise en file outbox et l'audit motivé.
- Le webhook facture récupère la souscription Stripe avant d'ouvrir la transaction PostgreSQL. La projection
  et la marque d'idempotence restent atomiques. Les notifications et intentions par appareil font
  aussi partie de cette transaction ; seul le réseau est différé au worker. Un doublon ne recrée pas de tâche.
  `notification-billing.ts` partage le prédicat de pertinence Stripe entre programmation et envoi ; le contexte
  reste interne. Voir [notifications durables](durable-notifications.md) pour le schéma et les limites d’acquittement.
- L’effacement ne fournit plus de callback réseau à `PrivacyRepository`. Le worker prend un verrou de session,
  effectue un lot externe, puis enregistre sa progression avec contrôle du propriétaire outbox. Les écrivains
  locaux sont coordonnés par les triggers de la baseline ; les webhooks ignorent un compte désactivé en
  conservant la sérialisation de la relation Customer. Voir [effacement reprenable](account-erasure.md).
- Les requêtes, index, paramètres, curseurs et ordre des effets existants sont préservés. Un découpage de fichiers
  ne doit pas transformer un verrou local à une transaction en plusieurs appels indépendants.

## Découpage volontairement limité

`ConfigService` reste le point d'assemblage de la configuration, avec ses parseurs dédiés et le trousseau JWT
isolé dans `jwt-keys.ts`. Sa longueur seule ne justifie pas de disperser les validations croisées entre secrets,
environnement et fournisseurs. Les services métier restent des orchestrateurs ; l'objectif n'est pas de créer
une classe par méthode ou d'imposer une architecture distribuée.

Les tests HTTP suivent les contrats documentés. Les intégrations exercent les repositories réels, les reprises
et la concurrence ; les tests unitaires isolent notamment les échecs fournisseur. Voir [`test.md`](../test.md)
pour les commandes et prérequis ; les bilans réellement exécutés sont dans la [roadmap](roadmap.md).
