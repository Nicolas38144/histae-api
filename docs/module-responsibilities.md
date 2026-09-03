# Frontières de responsabilités

Mise à jour : 3 septembre 2026. Ce refactoring conserve les routes, DTO, erreurs, règles métier et schéma SQL.
Il n'ajoute ni dépendance ni service à déployer.

## Composants spécialisés

| Domaine | Composant | Responsabilité |
| --- | --- | --- |
| Matchs | `MatchesRepository` | Création, listes et projections, révélation, continuation et quotas. |
| Matchs | `MatchMessageRepository` | Pagination des messages, envoi idempotent et accusés de lecture. |
| Matchs | `MatchMaintenanceRepository` | Élection transactionnelle du worker puis transitions et purge. Le timer et le suivi opérationnel restent dans `MatchMaintenanceService`. |
| Administration | `AdminRepository` | Recherche/détail des comptes, bannissement et accès audité aux conversations. |
| Administration | `AdminMetricsRepository` | Agrégats de consultation et estimation de revenu, sans mutation métier. |
| Administration | `AdminPhotoRepository` | Liste et remise en file des photos réconciliables, sans accès S3 ni signature d'URL. |
| Facturation | `BillingService` | Projection utilisateur, Checkout, portail et suppression du Customer pour l'effacement. |
| Facturation | `StripeWebhookService` | Vérification du webhook, mapping fournisseur, projection idempotente et effets après commit. |

Les modules Nest injectent directement ces composants. Il n'existe pas de façade de repository qui recrée ses
dépendances avec `new` ou conserve une copie des anciennes méthodes. Les contrôleurs gardent leurs guards,
validations et limites de débit existants ; le dashboard n'a aucune adaptation à faire.

## Frontières transactionnelles à conserver

- `match-access.ts` reçoit le `PoolClient` de l'appelant. Révélation et messagerie partagent ainsi les mêmes
  contrôles de participation, verrouillage et expiration ; l'utilitaire ne démarre pas une autre transaction.
- `matches.constants.ts` porte la durée de purge déjà existante, sans changement de rétention.
- `admin-audit.ts` reçoit la transaction de la consultation ou mutation protégée. La réconciliation photo
  conserve dans ce même commit le passage à `deleting`, la remise en file outbox et l'audit motivé.
- Le webhook facture récupère la souscription Stripe avant d'ouvrir la transaction PostgreSQL. La projection
  et la marque d'idempotence restent atomiques ; les notifications ne sont tentées qu'après succès du commit et
  jamais pour un doublon. Leur mécanisme de livraison existant n'est pas changé par ce refactoring.
- Les requêtes, index, paramètres, curseurs et ordre des effets existants sont préservés. Un découpage de fichiers
  ne doit pas transformer un verrou local à une transaction en plusieurs appels indépendants.

## Découpage volontairement limité

`ConfigService` reste le point d'assemblage de la configuration, avec ses parseurs dédiés et le trousseau JWT
isolé dans `jwt-keys.ts`. Sa longueur seule ne justifie pas de disperser les validations croisées entre secrets,
environnement et fournisseurs. Les services métier restent des orchestrateurs ; l'objectif n'est pas de créer
une classe par méthode ou d'imposer une architecture distribuée.

Les tests de contrat HTTP sont inchangés fonctionnellement. Les intégrations exercent les nouveaux repositories
réels, et les tests unitaires couvrent en plus l'ordre fetch/transaction/notification du webhook, les doublons,
les transactions échouées et le refus de lancer une maintenance sans son verrou. Voir [`test.md`](../test.md)
pour les résultats réellement exécutés.
