# Histae API — feuille de route

État au 5 septembre 2026.

Ce document contient uniquement les travaux encore ouverts et leurs critères de fin. L’état fonctionnel courant
est dans [resume.md](../resume.md), les contrats dans [routes.md](../routes.md) et les procédures de validation
dans [test.md](../test.md). Une case ouverte exprime un besoin identifié, pas nécessairement un défaut exploité.

## État acquis

| Lot | Résultat |
| --- | --- |
| R01 | Notifications et tâches push durables, reprises par appareil et éligibilité contrôlée |
| R02 | Effacement de compte asynchrone, reprenable et visible dans le dashboard |
| R03 | Tests de concurrence et de coupure locale, plus correctif du pool Scylla |
| R04 | Suivi Sweego, callbacks signés et traitement des issues incertaines |
| R05 (implémentation) | Réconciliation Stripe durable, protection optimiste, watchdog Customer anti-doublon et file opérateur minimale |
| R07 | Logs normalisés, exceptions et chemins minimisés, politique de rétention et tests anti-régression |
| PostgreSQL | Baseline figée de 44 tables puis migration incrémentale `015_stripe_reconciliation` |

Dernière validation : lint, typecheck, build, 568 tests autonomes et 190 intégrations locales, soit 758 tests dans
92 suites. Les intégrations complètes passent par quatre processus successifs et le second `db:migrate` n’a appliqué
aucun changement. Le dashboard passe également typecheck, lint et build de production. Ce résultat ne couvre ni
fournisseur réel, ni restauration, ni charge, ni pentest indépendant.

## Priorités

| Référence | Travail | Priorité | Périmètre |
| --- | --- | --- | --- |
| R05-S | Valider les parcours réels dans la sandbox Stripe | P1 avant production | API, exploitation |
| R06 | Borner les traitements et les exports | P2 | API |
| R08 | Raccorder les métriques à des alertes | P1 avant production | API, exploitation |
| R09 | Calibrer la modération et organiser les recours | P1 avant ouverture | API, dashboard, produit |
| R10 | Tester sauvegarde, restauration et déploiement | P1 avant production | Infrastructure |
| R11 | Formaliser la récupération WebAuthn | P1 avant production | Administration |
| R12 | Réaliser charge et contrôles de sécurité complémentaires | P1 avant production | API, exploitation |
| R13 | Obtenir les décisions produit et juridiques | P1 avant production | Produit, DPO/juriste |

<a id="r05-stripe"></a>
## R05-S — Validation Stripe en sandbox

Le code réconcilie désormais par lots `user_subscription`, récupère les créations Customer incertaines sans
rejouer un `POST` après 23 heures, répare l’arrêt entre persistance et rattachement, bloque une nouvelle clé tant
que l’intention précédente reste incertaine, protège la projection par version/snapshot et rend les dead letters
actionnables avec WebAuthn récent, motif et audit. Les tests synthétiques couvrent webhook perdu/retardé/rejoué,
ambiguïtés et concurrence. Voir [le protocole](stripe-reconciliation.md).

- [ ] Valider dans la sandbox du projet un paiement avec authentification renforcée, puis un renouvellement.
- [ ] Valider annulation immédiate, annulation en fin de période, échec de paiement et remboursement.
- [ ] Retarder ou perdre les webhooks de chaque parcours et confirmer la convergence après maintenance/outbox.
- [ ] Vérifier l’absence de doublon de notification ou d’effet et archiver les preuves sans donnée de paiement.

Terminé lorsque ces parcours réels convergent vers la même projection que les webhooks nominaux et que la
procédure opérateur a été répétée depuis le dashboard.

<a id="r06-volumes"></a>
## R06 — Volumes, lots et exports

- [ ] Découper la maintenance des matchs en lots reprenables sans perdre ses garanties de concurrence.
- [ ] Augmenter le débit de purge outbox de façon bornée ; 50 événements par heure ne suffisent pas forcément.
- [ ] Ajouter les curseurs manquants aux listes administratives plafonnées à 500 éléments.
- [ ] Définir pour l’export un instantané cohérent ou documenter explicitement sa cohérence plus faible.
- [ ] Éviter d’assembler un export volumineux intégralement en mémoire ; choisir streaming ou objet temporaire privé.
- [ ] Mesurer volumes, mémoire, durée et verrouillage avant de fixer les tailles de lots.

Terminé lorsque chaque traitement possède une borne, une progression, une reprise et un test de volume représentatif.

<a id="r08-alertes"></a>
## R08 — Alertes et supervision

- [ ] Exporter les agrégats existants vers l’outil de supervision retenu, sans nouvelle cardinalité utilisateur.
- [ ] Définir seuils et fenêtres pour HTTP, Sweego, Stripe, S3, Scylla, Redis, pool PostgreSQL et event loop.
- [ ] Alerter sur dead letters, ancienneté outbox, maintenance absente ou bloquée et retard de réconciliation.
- [ ] Écrire les runbooks, l’escalade, l’astreinte et la procédure de test des alertes.

Terminé lorsqu’un incident injecté déclenche l’alerte attendue et mène à un runbook vérifié.

<a id="r09-moderation"></a>
## R09 — Modération et recours

- [ ] Constituer un corpus représentatif autorisé et mesurer faux positifs, faux négatifs et biais.
- [ ] Versionner politique, règles textuelles et seuils photo sans publier un score comme une certitude.
- [ ] Définir SLA, habilitations, exposition minimale des reviewers et double revue si nécessaire.
- [ ] Fournir à l’utilisateur une explication utile et un recours traçable.
- [ ] Mesurer taille et âge de la file ainsi que les décisions annulées.

Terminé lorsque les limites sont mesurées, les décisions contestables et toute panne maintenue en revue humaine.

<a id="r10-sauvegardes"></a>
## R10 — Sauvegarde et déploiement

- [ ] Fixer les objectifs acceptables de perte de données et de délai de reprise.
- [ ] Restaurer réellement une sauvegarde PostgreSQL dans un environnement isolé.
- [ ] Choisir puis tester une cible objet privée, durable, sauvegardée et supervisée.
- [ ] Définir réparation, réplication, sauvegarde et montée de version de ScyllaDB.
- [ ] Documenter l’effacement de données réapparues après restauration.
- [ ] Vérifier TLS, ports, proxies de confiance, rotation des secrets et procédure d’incident.

Terminé lorsque restauration et rotation sont démontrées. SeaweedFS `weed mini` reste limité au développement.

<a id="r11-webauthn"></a>
## R11 — Exploitation WebAuthn

- [ ] Imposer au moins deux passkeys par administrateur, dont un moyen de secours distinct.
- [ ] Protéger et auditer l’enrôlement hors bande ; tester la perte d’un appareil.
- [ ] Définir la révocation lors d’un départ ou d’une compromission et les alertes associées.
- [ ] Vérifier en production HTTPS, origine, RP ID, cookie `__Host-` et chaîne de proxy.

Terminé lorsque la récupération fonctionne sans affaiblissement permanent ni dépendance à un SSO externe.

<a id="r12-securite"></a>
## R12 — Sécurité et charge

- [ ] Tester charge et abus sur OTP, autorisations objet, multipart/HEIC, swipes, webhooks et URLs signées.
- [ ] Définir des budgets de latence, mémoire, débit et concurrence avant optimisation supplémentaire.
- [ ] Réexécuter régulièrement audit des dépendances, recherche de secrets et analyse statique.
- [ ] Faire réaliser un pentest authentifié avant une exposition publique significative.
- [ ] Automatiser ces contrôles lorsque la stratégie CI/CD sera décidée.

Les audits `pnpm audit` du 1er septembre 2026 n’avaient signalé aucune vulnérabilité connue à cette date.
Ils ne couvrent pas l’infrastructure, ne remplacent pas un audit actuel et ne constituent pas un pentest.

<a id="r13-juridique"></a>
## R13 — Décisions produit et juridiques

- [ ] Faire valider textes, finalités, bases légales, versions et consentements.
- [ ] Décider si une AIPD est nécessaire et traiter les comptes durablement inactifs.
- [ ] Valider sous-traitants, transferts, sauvegardes et purge après restauration.
- [ ] Faire approuver rétentions, règles de modération, recours et conservation des traces.
- [ ] Conserver une référence vérifiable à chaque décision.

Terminé lorsque les décisions compétentes sont traduites dans la configuration, le code, les migrations,
les tests et la documentation concernés. Voir [politique de conservation](retention-policy.md) et
[checklist juridique](legal-release-checklist.md).

## Ordre conseillé

1. R05-S : validation fournisseur avant toute facturation réelle.
2. R06 et R08 : capacité et exploitation avant montée en charge.
3. R09 à R12 : préparation complète avant ouverture publique.
4. R13 : à mener en parallèle avec les responsables produit et juridiques.

Mettre ce fichier à jour à la fin de chaque lot. Garder ici un bilan synthétique ; placer procédures et invariants
durables dans les guides spécialisés.
