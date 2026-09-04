# Performance SQL PostgreSQL

Mise à jour : 4 septembre 2026. Mesures historiques conservées ; les ajouts R02/R03 sont décrits sans nouveau benchmark.

## Portée et méthode

L’audit couvre les requêtes PostgreSQL des 18 repositories/stores de `src`, les accès de santé et d’authentification,
les scripts d’exploitation, les fonctions du schéma et les requêtes de rétention. Les requêtes CQL de découverte
ScyllaDB ne sont pas des requêtes SQL et restent régies par leurs deux tables orientées requêtes.

Chaque prédicat a été rapproché des contraintes, index partiels, ordres de tri et limites réelles. Les chemins
critiques ont ensuite été exécutés avec `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` sur PostgreSQL 18.4 local. Les
jeux volumineux utilisés pour les matchs et les présences ont été créés dans une transaction, puis annulés et les
statistiques restaurées. Ces mesures valident un chemin d’accès ; elles ne prédisent pas la latence de production.

## Optimisations appliquées

### Feed

- La latitude/longitude du candidat n’est plus convertie avant le filtre de bounding box. L’index partiel des
  présences fraîches peut donc participer au plan.
- Les bornes d’âge utilisent directement `birthdate` ; `age()` ne sert plus de filtre sur chaque candidat.
- `statement_timestamp()` évite de rendre le CTE candidat volatile et inutilement matérialisé.
- Distance, consentements, préférences, blocages et matchs existants sont évalués avant la page.
- Les agrégats de traits et réponses ainsi que la modération de la bio ne sont chargés que pour les lignes de la
  page matérialisée.

Sur 403 profils locaux munis de présences transactionnelles, le plan chaud retourne 21 lignes en 5,2–5,5 ms,
touche environ 1 761 blocs en cache et n’exécute les agrégats de collections que 21 fois. Le plan antérieur
effectuait un scan séquentiel des présences et enrichissait les candidats avant la limite finale.

### Matchs et messages

- Les matchs où l’utilisateur est `user1_id` et `user2_id` sont lus par deux branches `UNION ALL` disjointes.
  Chaque branche applique filtre, curseur, tri et top-N via son index d’activité dédié ; leur fusion applique ensuite
  l’offset de compatibilité et la limite globale.
- Le détail profil, le dernier message et le compteur non lu sont joints après cette page, jamais à l’ensemble des
  matchs du membre.
- L’index des messages non lus inclut `sender_id`, ce qui évite des lectures de table pour le comptage lorsque la
  visibilité de l’index le permet.
- La lecture groupée combine la recherche de borne et la mise à jour dans une seule commande SQL. La révélation
  combine également écriture et calcul d’état. Les commandes verrouillées récupèrent l’heure PostgreSQL avec la
  ligne verrouillée au lieu d’effectuer un aller-retour séparé.

Avec 20 000 matchs et dix messages par match du membre générés transactionnellement, le plan chaud de la liste
détaillée prend 4,2–4,4 ms, utilise `idx_match_init_user1_activity` et `idx_match_init_user2_activity`, et exécute
les deux agrégats message seulement pour les 21 résultats demandés.

### Dashboard administrateur

- La pagination des comptes actifs dispose d’un index sur `(created_at, user_id)`.
- Une recherche exacte par UUID compare maintenant la colonne UUID sans la convertir en texte.
- La recherche de prénom par sous-chaîne utilise l’extension PostgreSQL standard `pg_trgm` et un index GIN. Sur le
  petit seed local, le scan séquentiel reste rationnel ; en désactivant ce choix uniquement pour contrôler
  l’éligibilité, PostgreSQL sélectionne bien `idx_user_profile_firstname_trgm`.
- Les listes de modération sans filtre, par type et par statut disposent d’ordres d’index adaptés. La file de
  réconciliation photo possède un ordre global propre aux statuts actionnables.
- Le compteur d’abonnements agrège les comptes une seule fois puis rejoint le petit catalogue de plans. L’ancienne
  forme produisait d’abord `nombre_de_plans × nombre_de_comptes` lignes.

### Rétention, exports et workers

- Les index de rétention incluent désormais l’identifiant servant à la suppression bornée : OTP, refresh tokens,
  notifications, tombstones, jetons de suppression, consentements retirés, demandes RGPD, signalements, sessions
  et audits administratifs.
- Les nettoyages ayant deux états disjoints limitent chaque branche indexée avant leur fusion. Cela évite de trier
  toute l’historique des événements outbox, challenges, bootstraps et sessions pour supprimer un petit lot.
- Les exports disposent d’index orientés utilisateur pour les messages envoyés et signalements soumis. Les listes
  de blocages et journaux d’accès suivent leur ordre de restitution.
- L’estimation de revenu filtre les abonnements par plan et date via un index composite.

## Requêtes volontairement conservées

Les lectures par clé primaire ou contrainte unique, les écritures `ON CONFLICT`, les vérifications de token, les
transitions Stripe et photo, ainsi que les agrégats sur les catalogues très petits étaient déjà sur un chemin borné.
Elles n’ont pas été condensées au prix d’une perte d’atomicité ou d’un index supplémentaire à chaque écriture.

Les exports RGPD restent séquentiels sur un même client PostgreSQL et ne construisent pas un énorme document
JSON dans la mémoire du serveur. L’isolation actuelle ne garantit pas un snapshot commun à toutes les requêtes ;
leur cohérence et leur assemblage en mémoire côté API restent à traiter dans R06. Les tableaux d’un seul
utilisateur dont la cardinalité métier est faible — trois réponses de profil, quelques traits, quatre types de
consentement, quelques appareils et passkeys — conservent leurs requêtes simples.

L’index global historique `idx_match_init_activity` est conservé pour l’instant : les nouveaux index participant
servent la route mobile, mais retirer un index déployé sans statistiques de production serait prématuré. Son usage
devra être réévalué après une période représentative.

## Exploitation

Complément R03 : les contrôles d’expiration des messages/continuations placent `clock_timestamp()` hors de la
CTE matérialisée portant `FOR UPDATE`, pour mesurer l’heure après une éventuelle attente sans requête supplémentaire.
La consommation initiale du quota exige aussi une limite positive. Les écritures profil/préférences/présence
verrouillent d’abord la clé primaire du compte, puis relisent les consentements requis avant mutation ; les
anciens tests d’existence du compte devenus redondants sont retirés. Aucune migration ni nouvel index.
Les tests réels valident ces courses ; leur passage n’est pas une mesure de débit ou de latence sous charge.

Complément R01 : la baseline garantit l’unicité de la clé de notification, l’unicité
notification/appareil et l’index de cascade par appareil. La programmation utilise une instruction avec CTE et
insertion ensembliste des tâches, sans boucle d’appels SQL par appareil. La livraison part de la clé primaire de
la tâche et relit les références et autorisations courantes. Les compteurs push sont agrégés dans la requête
outbox existante. Ces chemins sont exécutés par les tests PostgreSQL réels ; les mesures de plans historiques
ci-dessus ne constituent pas un benchmark des nouvelles requêtes. Leur charge reste à mesurer avec R06/R12.

La baseline conserve le contexte Stripe interne, sans index supplémentaire : les contrôles d’éligibilité communs à
la programmation et à l’envoi accèdent aux clés primaires existantes de `billing_invoice` et `user_subscription`.
Le nettoyage final à la désactivation utilise l’index de notifications par utilisateur. Les tests réels valident
les comportements et verrous ; ils ne constituent pas une mesure de performance sous charge.

Complément R02 : la baseline indexe les intentions Customer restant à effacer par `(user_id, id)` avec
un prédicat partiel. Les checkpoints accèdent à la clé primaire de la demande et à l’unicité outbox
`(event_type, aggregate_id)`. Les photos/Customers sont bornés à 50 par passage. Les listes de matchs vérifient
l’activité du partenaire avant le `LIMIT`, pour ne pas créer de pages incomplètes à cause du filtrage ultérieur.
Les guards d’écriture ajoutent un accès verrouillé à la clé primaire du compte ; ces nouveaux chemins sont
testés sur PostgreSQL réel, mais leur coût sous charge n’a pas été mesuré. Le suivi admin conserve sa limite
historique de 500 demandes, sans nouveau curseur (R06).

- Exécuter `ANALYZE` après un import important ou laisser autovacuum mettre les statistiques à jour.
- Observer en production les temps cumulés, lignes lues et blocs via `pg_stat_statements` si cette extension est
  activée par l’exploitant ; l’API n’en dépend pas.
- Contrôler régulièrement `pg_stat_user_indexes` avant de retirer un index : les compteurs locaux dominés par les
  tests ne représentent pas la production.
- Comparer des paramètres réalistes avec `EXPLAIN (ANALYZE, BUFFERS)` sur une copie non sensible. Ne jamais analyser
  une écriture de production sans transaction annulée et procédure explicite.
- Les index de l’ancienne migration `009_sql_performance_indexes` figurent maintenant dans la
  [baseline](postgres-migrations.md). Ils ne sont pas recréés sur une base déjà migrée. Pour tout nouvel index
  sur une base volumineuse, prévoir une fenêtre de migration ou une stratégie `CREATE INDEX CONCURRENTLY` séparée.
