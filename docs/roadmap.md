# Histae — travaux restants, améliorations et défauts

État consolidé au 4 septembre 2026. Ce document centralise les travaux ouverts identifiés dans le code et la documentation ; il ne constitue ni un audit exhaustif de sécurité ni une garantie d’absence d’autres défauts.

Le périmètre principal est l’API. Les extensions du dashboard proposées ci-dessous devront être confrontées à son état réel avant réalisation : elles ne sont pas toutes des absences vérifiées. Le client mobile n’est pas audité ici. Le développement sur une seule machine reste adapté ; les exigences de disponibilité concernent la future production.

## 1. État acquis et lecture des priorités

Ne pas refaire ce qui existe déjà :

- authentification administrateur WebAuthn native, sessions opaques, contrôle d’origine et authentification récente pour les actions sensibles ;
- familles de refresh tokens mobiles, rotation, détection du rejeu, révocation des sessions et rotation des clés JWT ;
- photo unique privée, conversion WebP, idempotence, cycle `user_photo`, outbox de suppression et réconciliation administrative ;
- modération photo/texte avec revue humaine et exclusion publique des contenus non approuvés ;
- questions de profil, réponses ordonnées et suppression en cascade ;
- métriques HTTP/dépendances, suivi persistant des maintenances et récupération auditée des dead letters ;
- optimisation SQL documentée et séparation récente des responsabilités matchs, administration et Stripe.

R01 à R04 sont livrés. Le bilan R04 comprend **87 suites et 718 tests**, dont 181 intégrations réelles PostgreSQL/Scylla/Redis/S3. [test.md](../test.md) décrit les commandes et prérequis, pas un compteur permanent de la couverture.

Priorités : **P1** = prochain lot ou exigence importante avant production ; **P2** = consolidation, à avancer selon les volumes et l’exposition. Une limite constatée n’implique pas qu’un incident se soit déjà produit. Un manque de tests n’est pas une vulnérabilité démontrée.

| Référence | Travail | Priorité | Périmètre principal |
| --- | --- | --- | --- |
| R01 | Livraison durable des notifications — terminé après revue | Livré le 03/09/2026 | API |
| R02 | Effacement de compte reprenable par étapes — terminé | Livré le 04/09/2026 | API et dashboard |
| R03 | Concurrence, pannes et régressions métier — terminé | Livré le 04/09/2026 | API |
| R04 | Suivi de livraison et issues incertaines Sweego — terminé | Livré le 04/09/2026 | API, fournisseur existant |
| R05 | Réconciliation Stripe et échecs persistants | P1 | API, dashboard éventuel |
| R06 | Traitements bornés, exports et pagination | P2 | API |
| R07 | Réduction des données dans les logs | P1 avant production | API |
| R08 | Alertes et supervision opérationnelle | P1 avant production | API, exploitation |
| R09 | Calibration et procédure de modération | P1 avant ouverture publique | API, admin, produit |
| R10 | Sauvegarde, restauration et sécurité de déploiement | P1 avant production | Infrastructure |
| R11 | Exploitation et récupération WebAuthn | P1 avant production | Administration |
| R12 | Charge et vérifications de sécurité complémentaires | P1 avant production | API, exploitation |
| R13 | Décisions produit et juridiques | P1 avant production | Produit, DPO/juriste |

### Consolidation PostgreSQL du 4 septembre

Le schéma final jusqu’à 014 est réuni dans `db/schema_postgres.sql`, avec une unique baseline
`001_baseline_20260904`. Les treize fichiers incrémentaux et la compatibilité historique sont retirés.
Le moteur initialise un schéma vide et refuse les versions inconnues ou checksums divergents.
La prochaine migration sera 015. Voir [la procédure](postgres-migrations.md).

La réécriture de lisibilité intègre les 133 anciens `ALTER TABLE` aux 44 `CREATE TABLE`, organisés par domaine
et dépendances. Les 98 index restent proches de leur table ; fonctions et triggers terminent le fichier.
La comparaison avant/après retrouve les mêmes 1 108 définitions, 17 commentaires SQL, valeurs de séquences
et seeds (400 profils, 15 questions, 400 bios en attente), dans deux schémas transactionnels ensuite annulés.
Le contrôle unitaire du catalogue protège cette organisation. Aucun objet du schéma public n’a été modifié.
Le rapport de sécurité redondant est retiré ; sa portée et ses limites restent en R12.

Le seed n’emploie plus la colonne photo retirée ; le reset connaît toutes les tables récentes et conserve les
extensions partagées. Il a d’abord été vérifié dans un schéma temporaire avant l’exécution locale autorisée.

**Validation exécutée :** lint, typecheck, build, 537 tests autonomes et 185 intégrations réussis, soit
722 tests dans 87 suites, avec sortie naturelle. Les 8 tests ciblés du catalogue et de la baseline sont inclus
dans ce total. Les anciens tests de transformation et d’adoption sont retirés ; les suites métier OTP/refresh
restent conservées.
Aucun contrat HTTP ni changement dashboard.

**Base locale :** le développeur a autorisé sa reconstruction sans sauvegarde. Le reset a supprimé l’ancien
schéma public et ses données de développement, puis installé exclusivement la baseline et ses 400 fixtures.
Un second `db:migrate` n’a appliqué aucun changement, confirmant le checksum courant.

## 2. Fiabilité métier

### R01 — Rendre les notifications durables — terminé après revue

**Livré.** La notification et ses tâches `notification.push` sont persistées dans la transaction de création du match/message ou de traitement du webhook Stripe. Chaque appareil a ses reprises indépendantes. La revue a reproduit puis corrigé deux défauts que les premiers tests ne couvraient pas. Voir [notifications durables](durable-notifications.md).

- [x] Enregistrer l’intention de notification dans la transaction métier, en réutilisant l’outbox PostgreSQL.
- [x] Définir une clé d’idempotence source/type/destinataire et des reprises par appareil ; SSE reste best-effort.
- [x] Tester les arrêts autour du commit/envoi/acquittement ; conserver le même `notification_id` après une issue incertaine.
- [x] Exposer les métriques `notification_push` et les reprises/abandons audités via les routes admin existantes.
- [x] Garder les textes privés hors des notifications et de FCM, sans copie des tokens dans les tâches.

**Correctifs issus de la contre-vérification :**

- [x] **Effacement concurrent.** La migration 012 nettoie les notifications intercalées après le premier nettoyage, dans la transaction qui désactive le compte et détient son verrou exclusif. Le verrou partagé du producteur est conservé, sans inverser l’ordre de verrouillage avec les matchs. Tests réels du cas initial et des deux ordres de concurrence, sans notification résiduelle.
- [x] **Alertes Stripe obsolètes.** Un prédicat SQL partagé vérifie la facture encore ouverte et due, ou l’abonnement encore en essai avec la même échéance future, à la programmation et avant envoi. Les références restent internes. Tests des événements anciens, paiement/activation/prolongation/expiration avant envoi et anciennes notifications sans contexte vérifiable, qui ne sont pas poussées.

**Validation exécutée :** migration 012 appliquée localement sans reset ni modification de 011, second passage idempotent ; lint/typecheck/build, 456 tests autonomes et 100 intégrations PostgreSQL/Scylla/Redis réussis, dont 34 scénarios notifications. Les deux régressions ont été reproduites avant correction ; 15 cas complètent les 19 scénarios initiaux. Un timeout de création de schéma lors d’un lancement parallèle ne s’est pas reproduit lors de la relance complète des intégrations seules, sans changer les délais. Aucun push réel envoyé. Toute évolution persistante suivante exige une migration après 012.

**Limite conservée :** FCM peut produire un doublon après une réponse perdue ; le mobile doit dédupliquer le `notification_id` et resynchroniser les ressources, SSE n’offrant pas de replay hors ligne. Aucun nouvel écran dashboard ni broker n’a été ajouté. Le débit de purge outbox reste à traiter dans R06.

### R02 — Rendre l’effacement de compte durablement reprenable — terminé

**Livré.** Le jeton de suppression et la programmation outbox sont atomiques. Le compte est désactivé dès l’acceptation ; `DELETE /api/users/me` répond maintenant **202** avec `request_id` et `status: in_progress`. Le worker reprend l’ordre Stripe → photos → Scylla → PostgreSQL sans appel réseau sous transaction SQL. Voir [le protocole et son exploitation](account-erasure.md).

- [x] Persister les étapes et la partition Scylla avec des erreurs normalisées ; lots de 50 Customers/photos et 100 références Scylla.
- [x] Sérialiser les écritures externes par des verrous de session, sans transaction longue ; refuser les écritures locales tardives par des guards PostgreSQL.
- [x] Reprendre les suppressions et checkpoints après réponse perdue, conserver les références techniques jusqu’à confirmation et refuser les checkpoints d’un worker ayant perdu sa revendication.
- [x] Masquer le compte dans le feed, les matchs et la messagerie dès sa désactivation ; acquitter les webhooks Stripe tardifs sans recréer ses projections.
- [x] Terminer atomiquement la DSR et le checkpoint après anonymisation PostgreSQL ; préserver les rétentions existantes.
- [x] Afficher la progression dans le dashboard et relancer les dead letters avec motif, authentification récente et audit ; aucun abandon d’effacement autorisé.

**Validation exécutée :** migration 013 appliquée sur `localhost/histae-dev`, second passage idempotent, sans reset. Les 26 scénarios PostgreSQL dédiés couvrent notamment les checkpoints perdus, l’upload S3 en cours, les écritures tardives, les verrous concurrents, les dead letters et leur reprise. Dix tests billing vérifient les issues Stripe incertaines ; le Scylla réel vérifie une partition de 120 références en deux lots. Les suites complètes restent vertes ; voir `test.md`.

**Limites explicites :** une création Customer dont la réponse reste inconnue après 23 heures est bloquée avec `erasure_stripe_reconciliation_required`, sans déclarer l’effacement terminé. La résolution contrôlée et le diagnostic des anciennes créations sans intention persistée relèvent de R05. R03 couvre désormais les arrêts de processus et les coupures de connexions locales ; les pannes de l’hôte complet, restaurations et validations sur la cible S3 de production restent R10. Ce protocole ne constitue pas une transaction distribuée.

### R03 — Compléter les tests de concurrence et de panne — terminé

**Livré.** Trois nouvelles suites, 33 scénarios et quatre correctifs. Voir [scénarios, isolation et limites](resilience-tests.md).

- [x] Continuations concurrentes et quota Free atomique, y compris limite nulle et expiration pendant l’attente du verrou. La création unique sur likes réciproques reste couverte dans la suite Scylla.
- [x] Tombstones, comptes bannis/effacés et expiration des restrictions.
- [x] Retrait des consentements sensibles/localisation et projections publiques, avec les deux ordres de concurrence face aux écritures.
- [x] Pagination matchs/signalements : égalités, microsecondes, frontières, filtre et insertion entre pages.
- [x] Maintenance sur données expirées et encore valides, lots bornés et exclusion entre workers.
- [x] Coupures de relais TCP Redis/Scylla/S3 et reprises, sans arrêter les conteneurs partagés.
- [x] Arrêts réels du worker aux checkpoints et perte de sa connexion PostgreSQL ; reprise finale sans double audit. Les 26 scénarios R02 et 34 scénarios notifications R01 restent conservés.

**Défauts corrigés :** réintroduction de données après retrait de consentement ; heure d’expiration lue avant
l’attente de `FOR UPDATE` ; première continuation allouée malgré une limite nulle ; ancien pool non fermé par
le pilote Scylla après remplacement d’un hôte. Les deux premières courses ont été reproduites avant correction ;
le test réseau a reproduit les ressources restant ouvertes du pilote. Le patch pnpm est limité à `cassandra-driver@4.9.0`.

**Validation exécutée :** lint, typecheck, build, 472 tests autonomes et 160 intégrations réussis, soit 632 tests
dans 82 suites. Sortie naturelle de Jest, sans `forceExit`. Aucun reset ni nouvelle migration ; les schémas,
UUID, objets, connexions et processus de test sont isolés et nettoyés. Petit refactoring des gardes transactionnelles
et des fixtures, sans nouveau contrat HTTP ni changement dashboard.

**Limites conservées :** réponses fournisseur contrôlées dans les tests d’arrêt du worker ; réseau réel testé
séparément. Sweego/Stripe restent R04/R05, charge R06/R12, panne de machine et restauration R10. Aucun nouvel
audit des dépendances ni pentest n’est revendiqué.

### R04 — Compléter le suivi Sweego — terminé

**Livré.** Le suivi distingue l’acceptation HTTP, le callback d’envoi, l’échec explicite et l’issue inconnue. Un callback signé peut récupérer une tentative dont la réponse d’envoi a été perdue, sans second POST ni réactivation d’un code consommé ou remplacé. Voir [le protocole et sa configuration](sweego-delivery.md).

- [x] Vérifier la documentation officielle : HMAC-SHA256 du corps brut, secret décodé en base64 et événements `sms_sent` / `sms_undelivered`. Aucune garantie documentée de déduplication des POST n’a été trouvée.
- [x] Séparer `pending`, `accepted`, `sent`, `failed` et `unknown`. `sms_sent` ne constitue pas une preuve de réception au téléphone ; celle-ci reste explicitement non confirmée.
- [x] Sérialiser les transitions par téléphone, vérifier la corrélation et rendre les callbacks monotones ; conserver l’usage unique, l’expiration après verrou et la priorité de la tentative acceptée la plus récente, même déjà consommée.
- [x] Définir les reprises mobiles sans renvoi automatique, borner le corps et le délai fournisseur, normaliser les erreurs sans conserver leur cause brute. Les agrégats `operations.sms_delivery` restent sans identifiant ni nouvelle rétention.
- [x] Tester réponse perdue, callback précoce/tardif/doublonné/désordonné, concurrence, purge, corrélation et indisponibilité ; deux cas utilisent un vrai serveur HTTP local qui interrompt ou laisse expirer une réponse partielle.

**Migration et refactoring :** 014 convertit les anciens `sent` en `accepted` et attribue un ordre chronologique déterministe aux tentatives historiques. Elle est appliquée sur `localhost/histae-dev`, avec second passage idempotent, sans reset. Arrêter les anciens écrivains OTP lors du déploiement ; toute évolution persistante suivante exige une migration après 014. Le SQL est extrait dans `OtpRepository`, les identifiants et limites fournisseur sont partagés, les erreurs sont typées. Aucun nouveau composant, dépendance ou écran dashboard.

**Validation exécutée :** lint, typecheck, build, 537 tests autonomes et 181 intégrations réussis, soit 718 tests dans 87 suites. Les 21 intégrations PostgreSQL dédiées couvrent le protocole et la migration historique ; elles sont incluses dans ce total. Les premiers passages globaux ont échoué avec des services locaux indisponibles, puis des dépassements de délai et un arrêt anormal du processus. Après rétablissement de l’environnement, les 35 tests du contrat PostgreSQL puis les 11 suites d’intégration complètes passent, sans augmenter les délais ni forcer l’arrêt de Jest. Les fixtures sont isolées ; aucun reset des stockages partagés. Aucun audit des dépendances ni pentest supplémentaire n’est revendiqué.

**Limites avant production :** configurer `SWEEGO_WEBHOOK_SECRET` et la destination HTTPS dans le compte Sweego, puis éprouver un SMS autorisé, la signature et les retries réels. La politique de re-signature des anciennes livraisons reste à vérifier ; Histae conserve sa fenêtre anti-rejeu. Aucun SMS réel n’a été envoyé par ces tests. Sans acquittement HTTP ni callback, le code reste inutilisable et l’issue inconnue : ne pas inventer de certitude fournisseur. Les métriques OTP ne concernent que les tentatives non expirées, les compteurs de callbacks sont propres au processus ; leur historisation/alerting relève de R08.

### R05 — Réconcilier Stripe et rendre ses anomalies opérables

**Amélioration restante.** Le traitement idempotent des webhooks existe ; il ne remplace pas une vérification périodique de convergence avec `user_subscription`.

- [ ] Ajouter une réconciliation planifiée, bornée et reprenable.
- [ ] Résoudre de manière contrôlée les créations Customer incertaines dépassant la fenêtre de rejeu de R02 et diagnostiquer celles antérieures à la migration 013 ; ne jamais forcer un effacement à `completed`.
- [ ] Empêcher qu’un événement ancien ou une réconciliation concurrente écrase un état plus récent.
- [ ] Conserver un suivi exploitable des échecs persistants sans enregistrer les erreurs brutes sensibles du fournisseur.
- [ ] Prévoir, si nécessaire dans le dashboard, une vue d’anomalies et des reprises protégées par authentification récente, motif et audit.
- [ ] Valider un parcours Stripe sandbox : paiement avec authentification renforcée, renouvellement, annulation et remboursement.

**Terminé lorsque :** un webhook perdu, retardé ou rejoué converge vers l’état attendu, sans doubler les effets ni attribuer des privilèges à partir de données choisies par le client.

## 3. Volumes et exploitation

### R06 — Borner les traitements et préciser la cohérence des exports

**Limites constatées.** [match-maintenance.repository.ts](../src/matches/match-maintenance.repository.ts) traite les lignes éligibles sans limite de lot dans une transaction leader. Ce constat ne s’applique pas à toutes les maintenances : certains nettoyages sont déjà bornés. Les exports sont assemblés en mémoire ; une transaction PostgreSQL sans isolation explicitement adaptée ne garantit pas un instantané commun à toutes les requêtes. Les listes RGPD administratives et journaux d’accès sont plafonnées à 500 éléments sans parcours complet par curseur.

- [ ] Découper la maintenance matchs en lots avec progression, limites et conservation des garanties de concurrence.
- [ ] Adapter le débit de purge de l’outbox : le worker continu ne supprime actuellement que 50 événements résolus par heure, soit 1 200 par jour par worker. Les notifications par appareil peuvent dépasser ce débit ; des lots bornés doivent pouvoir rattraper le stock éligible sans changer la rétention de 7 jours. Ce plafond préexistait à R01, qui augmente le volume concerné.
- [ ] Ajouter les curseurs manquants sans casser les contrats existants ; documenter les limites restantes.
- [ ] Définir une stratégie d’export adaptée au volume : bornage, streaming ou travail asynchrone selon les mesures.
- [ ] Définir l’isolation PostgreSQL requise et la cohérence attendue entre PostgreSQL et Scylla, sans prétendre disposer d’une transaction distribuée.
- [ ] Mesurer mémoire, durée, verrous et plans SQL sur des volumes représentatifs ; s’appuyer sur [l’audit SQL](sql-performance.md).

**Terminé lorsque :** la maintenance progresse sur un grand stock sans transaction démesurée et l’export respecte des limites documentées de ressources et de cohérence.

### R07 — Réduire les risques de divulgation dans les logs

**Surface de risque constatée.** Certains chemins billing et maintenance journalisent encore des messages d’erreur ou stacks. R01 a normalisé les erreurs push, les avertissements de livraison SSE et les erreurs du polling outbox ; la revue globale reste à faire. Ce constat ne prouve pas une fuite effective de secret.

- [ ] Inventorier les logs et remplacer les erreurs fournisseur brutes par des codes stables et des métadonnées autorisées.
- [ ] Centraliser les règles de rédaction et de masquage utiles, sans perdre la capacité de diagnostic.
- [ ] Tester l’absence de téléphone, token, clé, identifiant FCM, texte privé et justification sensible dans les sorties.

**Terminé lorsque :** les scénarios d’échec représentatifs produisent uniquement les données explicitement autorisées ; les détails internes ne passent jamais dans les erreurs HTTP publiques.

### R08 — Raccorder les métriques aux alertes de production

**Amélioration restante.** Les métriques internes existent, mais les compteurs en mémoire sont propres à une instance et repartent à zéro au redémarrage. Le suivi persistant des maintenances existe déjà.

- [ ] Collecter et historiser les latences, erreurs HTTP, taux de `401`/`403`/`429`/`5xx` et états des dépendances.
- [ ] Définir seuils, fenêtres, destinataires et procédures pour dead letters, retard de maintenance, outbox et anomalies de livraison.
- [ ] Superviser le démarrage, l’arrêt et le redémarrage des workers maintenance/outbox.
- [ ] Observer le coût et le comportement du feed hybride sous charge.
- [ ] Vérifier chaque alerte par une panne simulée, y compris sa résolution.

**Terminé lorsque :** une panne produit une alerte actionnable et une procédure de récupération éprouvée. Les métriques restent agrégées, sans identifiant utilisateur ni cardinalité non bornée. Le choix du système externe d’alertes relève du déploiement, pas d’une dépendance imposée au métier.

## 4. Modération, sécurité et préparation à la production

### R09 — Calibrer la modération et organiser les recours

**Limite fonctionnelle.** Les contrôles automatiques actuels constituent un triage, pas une preuve qu’une photo ou un texte est conforme dans tous les cas.

- [ ] Constituer un corpus représentatif utilisable légitimement, avec attendus validés.
- [ ] Mesurer faux positifs, faux négatifs et biais des contrôles visage/netteté/contenu et des règles texte.
- [ ] Documenter les catégories couvertes, non couvertes et les seuils/versionnements retenus.
- [ ] Formaliser habilitations, formation, délais de revue humaine et procédure d’appel.
- [ ] Adapter l’API et le dashboard aux recours seulement après définition du workflow produit et de sa rétention.

**Terminé lorsque :** les limites sont mesurées et documentées, les décisions sont contestables et les pannes restent en attente de revue. Préserver l’absence de rejet automatique et l’audit préalable aux accès sensibles.

### R10 — Éprouver la restauration et sécuriser le déploiement

- [ ] Définir les objectifs de perte de données et de délai de reprise acceptables, puis tester une restauration PostgreSQL complète.
- [ ] Choisir une cible objet durable ; tester restauration, contrôle des accès privés et cohérence avec `user_photo`.
- [ ] Définir sauvegarde, réparation, réplication et montée de version Scylla ; prévoir le niveau de disponibilité Redis adapté.
- [ ] Documenter le traitement des données effacées lors de la restauration d’une sauvegarde.
- [ ] Vérifier TLS, ports exposés, chaîne de proxy de confiance et interprétation de l’adresse client utilisée par le rate limiting.
- [ ] Mettre en place rotation/révocation des secrets, contrôle des accès et procédures d’incident.

**Terminé lorsque :** une restauration isolée et une rotation sont démontrées, avec procédures et résultats conservés. SeaweedFS `weed mini` reste un choix local acceptable ; ne pas confondre son démarrage avec une stratégie de sauvegarde ou de haute disponibilité. L’authentification Histae doit rester indépendante de Cloudflare.

### R11 — Formaliser l’exploitation WebAuthn

- [ ] Prévoir au moins deux passkeys par administrateur et un moyen de secours adapté, notamment une clé physique.
- [ ] Encadrer l’accès aux commandes d’enrôlement/récupération hors bande et tester la perte d’un appareil.
- [ ] Définir les alertes sur les actions sensibles et la révocation lors d’un départ ou d’une compromission.
- [ ] Vérifier la configuration HTTPS/origine/RP ID/cookies en production tout en conservant `localhost` en développement.

**Terminé lorsque :** la récupération est testée sans contournement permanent des contrôles ni recours obligatoire à un SSO externe. L’authentification native elle-même est déjà implémentée.

### R12 — Étendre les vérifications de sécurité et de charge

- [ ] Tester les charges et abus OTP, autorisations objet, upload multipart/HEIC, swipes, continuations, webhooks et URLs signées.
- [ ] Définir des budgets de latence, débit, mémoire et concurrence ; mesurer avant d’ajouter de nouvelles optimisations.
- [ ] Prévoir un audit/pentest indépendant avant exposition publique significative.
- [ ] Réexécuter régulièrement audit de dépendances, recherche de secrets et analyse statique ; suivre les correctifs réellement applicables.
- [ ] Automatiser ces contrôles lorsque la chaîne CI/CD sera décidée explicitement, sans créer de workflow par défaut.

**Portée des contrôles déjà réalisés :** les revues internes ont porté sur le code, la configuration, les
schémas, les contrats HTTP et les photos, avec des tests automatisés. Les contrôles en place sont décrits dans
`AGENTS.md` et `resume.md` ; les correctifs et validations R01–R04 restent dans leurs bilans ci-dessus.
Les audits `pnpm audit --audit-level low` et `pnpm audit --prod --audit-level low` du 1er septembre 2026
n’avaient signalé aucune vulnérabilité connue à cette date. Ils n’ont pas été renouvelés par les refactorings,
le patch Scylla ou la consolidation SQL. Aucun pentest indépendant, audit de l’infrastructure de production
ou avis juridique n’est attesté par ces résultats. L’ancien rapport détaillé redondant reste récupérable dans Git.

**Terminé lorsque :** les résultats, limites et correctifs sont documentés. Une revue interne et des tests verts
ne remplacent pas un pentest ni une vérification actuelle des dépendances.

### R13 — Obtenir les décisions produit et juridiques

- [ ] Faire valider les textes et leur versionnement, les finalités et les consentements.
- [ ] Faire trancher l’AIPD et les durées encore ouvertes, notamment les comptes inactifs.
- [ ] Valider sous-traitants, transferts, stockage de production et politique d’effacement des sauvegardes.
- [ ] Valider les règles de modération, de recours et de conservation des traces.
- [ ] Conserver une référence réelle à la validation obtenue ; ne pas inventer une approbation pour satisfaire la configuration.

**Terminé lorsque :** les décisions compétentes sont obtenues puis traduites, si nécessaire, dans le code, les migrations, les tests et la documentation. Références : [politique de rétention](retention-policy.md) et [checklist juridique](legal-release-checklist.md). Ce document ne fixe aucune nouvelle durée.

## 5. Frontières API, dashboard et mobile

R01 à R04 sont livrés, avec suivi des effacements dans le dashboard pour R02 et sans changement dashboard pour R03/R04. R04 ajoute le suivi OTP et les métriques API. R06 et R07 peuvent avancer principalement dans l’API avec les stockages déjà présents. R05 concerne Stripe déjà utilisé. R08/R10/R12 comprennent du travail d’exploitation qui ne se résout pas par du code API seul.

Pour le dashboard, vérifier avant ajout les besoins de suivi des anomalies de livraison/facturation et des recours de modération. Réutiliser les protections existantes : listes minimales, détail autorisé, motif/audit et authentification récente pour les opérations sensibles. Ne pas recréer les écrans de modération, de réconciliation photo ou de suivi des effacements déjà livrés.

Côté mobile, restent à **vérifier dans son propre dépôt**, sans les déclarer manquants ici :

- rafraîchissement des tokens en single-flight, stockage atomique de la paire et retour à l’OTP après une réponse de rotation perdue ; voir [sessions mobiles](mobile-sessions.md) ;
- gestion de `otp_delivery_unknown`, conservation de la clé d’intention OTP et absence de boucle automatique d’envoi avec de nouvelles clés ; voir [suivi Sweego](sweego-delivery.md) ;
- prise en charge du nouveau `202` de suppression : fermer la session dès acceptation, sans afficher prématurément que tous les stockages sont nettoyés ;
- intégration du catalogue et des trois réponses de profil, de leur ordre, de leur sauvegarde et de leur affichage ;
- présentation des statuts de modération, erreurs et éventuels recours.

## 6. Ordre conseillé et entretien du document

1. R05 : réconciliation Stripe, dont les créations Customer incertaines. La configuration réelle Sweego de R04 reste à éprouver avant production.
2. R06/R07 : débit de purge outbox, volumes, cohérence des exports et revue des logs restante.
3. Avant production : terminer R08 à R13 ; commencer tôt les décisions et procédures qui nécessitent des intervenants externes.

Pas de besoin démontré à ce stade de microservices, de Kafka, d’un remplacement général des stockages ou d’une nouvelle réécriture. Les extractions de responsabilités déjà réalisées sont décrites dans [module-responsibilities.md](module-responsibilities.md) ; poursuivre seulement là où un changement concret le justifie.

Après chaque lot : cocher uniquement les travaux validés, noter ici la preuve de validation, retirer les constats devenus obsolètes et synchroniser les documents concernés. Ce fichier porte le backlog et les bilans des lots ; [resume.md](../resume.md) conserve la synthèse architecturale, [routes.md](../routes.md) le contrat HTTP et [test.md](../test.md) les procédures, prérequis et limites de validation. Les scénarios détaillés restent dans les fichiers de test.
