# Baseline PostgreSQL consolidée

Depuis le 4 septembre 2026, `001_baseline_20260904` définit l’état PostgreSQL initial complet.
`db/schema_postgres.sql` contient les tables, contraintes, index, séquences, fonctions et triggers.
Les catalogues et les 400 profils de développement optionnels restent dans `db/insert_postgres.sql`.
Les anciennes migrations restent accessibles dans Git, mais ne sont plus exécutables par le code courant.

## Migration ordinaire

```powershell
pnpm run db:migrate
```

La commande est transactionnelle et sérialisée par verrou consultatif :

- sur un schéma vide, elle applique la baseline et les catalogues sans créer d’utilisateur factice ;
- sur une base à jour, elle contrôle le checksum puis ne fait rien ;
- elle refuse un schéma applicatif non vide sans historique courant, une version inconnue et un checksum absent ou modifié ;
- les futures évolutions persistantes seront ajoutées au catalogue à partir de `015_<description>`.

Le moteur ne tente plus d’adopter les anciennes chaînes. En développement, reconstruire la base avec le reset
protégé. Pour une base déjà déployée dans un autre environnement, écrire une migration de transition explicite
depuis sa version exacte au lieu de fabriquer ou modifier son historique.

## Reset local

```powershell
pnpm run db:reset
```

Le reset est destructif et autorisé uniquement avec `ENV=development`, un hôte PostgreSQL loopback
et la base exacte `histae-dev`. Il supprime les objets applicatifs, reconstruit la baseline, enregistre
son checksum et crée 400 profils factices avec leurs bios en modération `pending`.
Les extensions PostgreSQL, partagées au niveau de la base, restent installées.

## Organisation et validation

Les 44 tables sont regroupées par domaine, parents avant dépendants. Leurs clés primaires, unicités,
clés étrangères et colonnes auto-incrémentées sont définies directement dans les `CREATE TABLE` ;
la baseline ne contient aucun `ALTER TABLE`. Les index et commentaires suivent leur table, puis les
fonctions et triggers terminent le fichier.

`postgres.baseline.integration.spec.ts` vérifie la création, la concurrence d’initialisation, les refus,
les checksums et la reconstruction avec les seeds. Le test du catalogue protège l’organisation du SQL.
Commandes et isolation : [test.md](../test.md) ; dernier bilan : [roadmap](roadmap.md).
