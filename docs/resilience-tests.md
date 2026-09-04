# Concurrence et reprises après panne — R03

Mise à jour : 4 septembre 2026. Ce lot teste les invariants sur les stockages locaux existants ; il n’ajoute ni
service à héberger ni migration. Le contrat HTTP reste inchangé. Les résultats consolidés sont dans [test.md](../test.md).

## Scénarios

- `postgres.business-concurrency.integration.spec.ts` : 24 cas. Continuations simultanées, dernière place du quota
  Free, quota nul, expiration pendant l’attente du verrou, tombstones, comptes bannis/désactivés, retraits de
  consentement dans les deux ordres de concurrence, curseurs avec égalités/microsecondes et maintenances concurrentes.
  Les purges conservent des lignes encore valides pour vérifier qu’elles ne suppriment pas trop largement.
- `postgres.crash-recovery.integration.spec.ts` : 6 cas. Un vrai processus worker est arrêté avant les checkpoints
  Stripe, photos, Scylla et PostgreSQL, puis après le commit final mais avant l’acquittement outbox. Le processus
  suivant termine la demande avec une seule trace d’anonymisation. Un autre cas coupe la connexion PostgreSQL qui
  porte le verrou de session et vérifie le refus de l’écriture externe suivante.
- `network-recovery.integration.spec.ts` : 3 cas. Redis refuse le rate limiting pendant sa déconnexion et retrouve
  le compteur après reprise ; Scylla conserve la décision immuable puis termine l’effacement croisé ; une réponse
  S3 DELETE perdue après suppression réelle conserve la trace PostgreSQL jusqu’au retry réussi.

La création unique d’un match sur likes réciproques reste couverte par la suite Scylla historique. Les 34 cas
notifications R01 et 26 cas effacement R02 sont conservés.

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
4. **Pool Scylla abandonné.** Dans `cassandra-driver@4.9.0`, la réinitialisation de la connexion de contrôle après
   indisponibilité de tous les hôtes peut remplacer un `Host` sans fermer son ancien pool. Le test réseau réussissait
   fonctionnellement mais Jest ne se terminait pas : timers de santé et reconnexion restaient actifs. Le patch pnpm
   ferme ce pool en le laissant drainer les requêtes déjà en cours avant son remplacement.

## Correctif du pilote

`patches/cassandra-driver@4.9.0.patch` contient six lignes ajoutées dans `_setLocalInfo` ; la version reste 4.9.0.
Le hash est verrouillé dans `pnpm-lock.yaml` et l’application déclarée dans `pnpm-workspace.yaml`. Conserver ces trois
fichiers ensemble, et copier aussi `patches/` avant une installation dans une future image API.
`pnpm install --frozen-lockfile` applique le correctif sans édition manuelle de `node_modules`.

Le test réseau utilise le client et ses politiques de production, observe un remplacement d’hôte et s’arrête
naturellement, sans `forceExit` ni suppression arbitraire de timers. Lors d’une évolution du pilote, vérifier si
le correctif est intégré en amont, puis rejouer ce test avant de retirer ou porter le patch. Ce correctif ne prouve
pas la reprise de toutes les topologies Scylla : le test est volontairement mono-nœud local.

## Isolation et exécution

```powershell
pnpm install --frozen-lockfile
pnpm run test:integration

# Seulement les trois nouvelles suites
pnpm exec jest --runInBand --testPathPatterns='postgres.business-concurrency|postgres.crash-recovery|network-recovery'
```

Prérequis : PostgreSQL `histae-dev` en développement, Scylla activé et migré dans `histae_discovery`, Redis local,
bucket S3 local accessible en HTTP. Les relais refusent une cible autre que `localhost`, `127.0.0.1` ou `::1`.
Le scénario Scylla demande un seul nœud sans TLS et le scénario Redis utilise exclusivement la base logique 15.

Les fixtures rejouent les migrations dans leurs schémas PostgreSQL aléatoires `r03_test_<uuid>`. Elles vérifient
le schéma avant nettoyage et ne suppriment que celui qu’elles ont créé. Les données Scylla et l’objet S3 utilisent
des UUID propres au test ; leur nettoyage est ciblé. Les compteurs Redis uniques expirent en 30 secondes.
La fixture S3 teste le transport et le cycle de suppression, pas la validité du contenu WebP.

Les coupures passent par des relais TCP loopback éphémères et touchent uniquement les connexions qu’ils ont ouvertes.
Les conteneurs partagés ne sont ni arrêtés ni réinitialisés. Seul le processus enfant créé par le test est tué ;
sa configuration PostgreSQL passe par IPC, jamais par les arguments, les logs ou un fichier de secrets.
La date de revendication outbox est vieillie uniquement dans le schéma de test pour accélérer la reprise.

## Limites conservées

Les étapes fournisseur du processus arrêté utilisent des réponses contrôlées ; les coupures réseau réelles sont
testées séparément. Ni Stripe, Sweego ni FCM ne sont appelés. Les contrats et issues fournisseur relèvent de R04/R05.
Ces tests ne simulent pas une panne électrique de l’hôte, une perte de disque ou une restauration de sauvegarde (R10),
ni la charge et les budgets de performance (R06/R12). Ils ne garantissent pas une transaction distribuée ni
l’absence d’une réponse arbitrairement tardive du fournisseur. Ils ne remplacent pas un audit de sécurité indépendant.
