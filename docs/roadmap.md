# Histae — travaux restants, améliorations et défauts

État consolidé au 3 septembre 2026. Ce document centralise les travaux ouverts identifiés dans le code et la documentation ; il ne constitue ni un audit exhaustif de sécurité ni une garantie d’absence d’autres défauts.

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

Après la revue et les corrections de R01 du 3 septembre, **76 suites et 556 tests passent**, ainsi que lint, typecheck et build. Les deux défauts reproduits lors de la contre-vérification sont corrigés et couverts par des régressions ; R01 est terminé. Voir [test.md](../test.md) pour les résultats et leur portée.

Priorités : **P1** = prochain lot ou exigence importante avant production ; **P2** = consolidation, à avancer selon les volumes et l’exposition. Une limite constatée n’implique pas qu’un incident se soit déjà produit. Un manque de tests n’est pas une vulnérabilité démontrée.

| Référence | Travail | Priorité | Périmètre principal |
| --- | --- | --- | --- |
| R01 | Livraison durable des notifications — terminé après revue | Livré le 03/09/2026 | API |
| R02 | Effacement de compte reprenable par étapes | P1 | API, suivi admin éventuel |
| R03 | Concurrence, pannes et régressions métier | P1 | Tests API |
| R04 | Suivi de livraison et issues incertaines Sweego | P1 | API, fournisseur existant |
| R05 | Réconciliation Stripe et échecs persistants | P1 | API, dashboard éventuel |
| R06 | Traitements bornés, exports et pagination | P2 | API |
| R07 | Réduction des données dans les logs | P1 avant production | API |
| R08 | Alertes et supervision opérationnelle | P1 avant production | API, exploitation |
| R09 | Calibration et procédure de modération | P1 avant ouverture publique | API, admin, produit |
| R10 | Sauvegarde, restauration et sécurité de déploiement | P1 avant production | Infrastructure |
| R11 | Exploitation et récupération WebAuthn | P1 avant production | Administration |
| R12 | Charge et vérifications de sécurité complémentaires | P1 avant production | API, exploitation |
| R13 | Décisions produit et juridiques | P1 avant production | Produit, DPO/juriste |

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

### R02 — Rendre l’effacement de compte durablement reprenable

**Limite constatée.** Le flux de [privacy.service.ts](../src/privacy/privacy.service.ts) et [privacy.repository.ts](../src/privacy/privacy.repository.ts) peut effectuer les suppressions externes pendant une transaction PostgreSQL verrouillée. Une panne prolonge la transaction ; son rollback ne restaure pas les données déjà supprimées ailleurs.

- [ ] Persister les étapes, leur progression et les reprises avec des erreurs normalisées.
- [ ] Séparer les appels réseau des longues transactions tout en conservant l’ordre documenté Stripe/photos/Scylla/PostgreSQL et les invariants de blocage du compte.
- [ ] Rendre chaque étape idempotente, y compris après une réponse réseau perdue.
- [ ] Bloquer les nouvelles mutations pendant l’effacement et vérifier qu’aucune autre ressource métier ne se recrée après son nettoyage ; R01 sécurise les notifications, pas tout le protocole d’effacement.
- [ ] Ne déclarer la demande terminée qu’après les étapes requises ; conserver les traces nécessaires à la reprise, sans contenu personnel inutile.
- [ ] Prévoir une action de reprise administrative auditée si une intervention est nécessaire.

**Terminé lorsque :** un arrêt ou timeout à chaque étape permet une reprise après redémarrage, sans réexposer le compte ni laisser une demande faussement achevée. Les durées de rétention ne sont pas modifiées sans décision explicite.

### R03 — Compléter les tests de concurrence et de panne

**Couverture à étendre**, pas liste de bugs avérés. Les tests réels des refresh tokens existent désormais : ne pas les remettre entièrement dans les travaux à faire.

- [ ] Continuations concurrentes : second consentement, création unique et consommation atomique du quota Free.
- [ ] Tombstones, comptes bannis/effacés et expiration des restrictions.
- [ ] Retrait des consentements sensibles et de localisation : effacement immédiat et projections publiques.
- [ ] Pagination des matchs et signalements : stabilité, frontières et absence de doublons.
- [ ] Maintenance sur jeux de données réellement expirées, avec plusieurs workers.
- [ ] Pannes transitoires et reprises Redis, Scylla et S3 dans un environnement local isolé et jetable.
- [ ] Scénarios de panne des futures étapes R02, plus Sweego et Stripe détaillés ci-dessous. Conserver les 34 scénarios notifications validés dans R01, dont les régressions d’effacement concurrent et de facturation obsolète.

**Terminé lorsque :** les scénarios sont reproductibles et testent les invariants en base, pas seulement les réponses mockées. Ne pas couper ou réinitialiser une infrastructure partagée sans autorisation.

### R04 — Compléter le suivi Sweego

**Limite constatée.** L’acceptation fournisseur ne prouve pas la livraison du SMS. Une réponse perdue peut être traitée comme un échec alors que le SMS arrive, avec un OTP potentiellement inutilisable.

- [ ] Vérifier le contrat fournisseur actuel : statuts disponibles, authentification des callbacks et garanties d’idempotence.
- [ ] Distinguer acceptation, livraison, échec et issue incertaine sans inventer une garantie du fournisseur.
- [ ] Gérer les callbacks rejoués ou désordonnés et les pertes de réponse sans fragiliser l’usage unique des OTP.
- [ ] Définir la conduite de reprise et les métriques de délai/échec, sans téléphone ni OTP dans les logs.
- [ ] Tester les cas SMS livré/réponse perdue, callback tardif, doublon et indisponibilité.

**Terminé lorsque :** chaque issue est observable et la reprise n’entraîne ni réutilisation d’OTP ni envoi incontrôlé. Ce lot utilise Sweego déjà présent, pas un nouveau composant à héberger.

### R05 — Réconcilier Stripe et rendre ses anomalies opérables

**Amélioration restante.** Le traitement idempotent des webhooks existe ; il ne remplace pas une vérification périodique de convergence avec `user_subscription`.

- [ ] Ajouter une réconciliation planifiée, bornée et reprenable.
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

**Terminé lorsque :** les résultats, limites et correctifs sont documentés. Le [check-up interne](security-checkup.md) et les tests verts ne remplacent pas un pentest ; l’audit des dépendances n’a pas été renouvelé simplement parce que le refactoring est passé.

### R13 — Obtenir les décisions produit et juridiques

- [ ] Faire valider les textes et leur versionnement, les finalités et les consentements.
- [ ] Faire trancher l’AIPD et les durées encore ouvertes, notamment les comptes inactifs.
- [ ] Valider sous-traitants, transferts, stockage de production et politique d’effacement des sauvegardes.
- [ ] Valider les règles de modération, de recours et de conservation des traces.
- [ ] Conserver une référence réelle à la validation obtenue ; ne pas inventer une approbation pour satisfaire la configuration.

**Terminé lorsque :** les décisions compétentes sont obtenues puis traduites, si nécessaire, dans le code, les migrations, les tests et la documentation. Références : [politique de rétention](retention-policy.md) et [checklist juridique](legal-release-checklist.md). Ce document ne fixe aucune nouvelle durée.

## 5. Frontières API, dashboard et mobile

R01 est livré côté API après correction des deux défauts reproduits en revue. R02, R03, R06 et R07 peuvent avancer principalement dans l’API avec les stockages déjà présents. R04/R05 concernent des fournisseurs déjà utilisés. R08/R10/R12 comprennent du travail d’exploitation qui ne se résout pas par du code API seul.

Pour le dashboard, vérifier avant ajout les besoins de suivi des effacements, anomalies de livraison/facturation et recours de modération. Réutiliser les protections existantes : listes minimales, détail autorisé, motif/audit et authentification récente pour les opérations sensibles. Ne pas recréer les écrans de modération ou de réconciliation photo déjà livrés.

Côté mobile, restent à **vérifier dans son propre dépôt**, sans les déclarer manquants ici :

- rafraîchissement des tokens en single-flight, stockage atomique de la paire et retour à l’OTP après une réponse de rotation perdue ; voir [sessions mobiles](mobile-sessions.md) ;
- intégration du catalogue et des trois réponses de profil, de leur ordre, de leur sauvegarde et de leur affichage ;
- présentation des statuts de modération, erreurs et éventuels recours.

## 6. Ordre conseillé et entretien du document

1. R02 : effacement reprenable, avec tests de reprise à chaque étape.
2. R03 : compléter les autres scénarios métier et de concurrence prioritaires.
3. R04/R05 : suivi Sweego et réconciliation Stripe.
4. R06/R07 : débit de purge outbox, volumes, cohérence des exports et revue des logs restante.
5. Avant production : terminer R08 à R13 ; commencer tôt les décisions et procédures qui nécessitent des intervenants externes.

Pas de besoin démontré à ce stade de microservices, de Kafka, d’un remplacement général des stockages ou d’une nouvelle réécriture. Les extractions de responsabilités déjà réalisées sont décrites dans [module-responsibilities.md](module-responsibilities.md) ; poursuivre seulement là où un changement concret le justifie.

Après chaque lot : cocher uniquement les travaux validés, noter la preuve de validation, retirer les constats devenus obsolètes et synchroniser les documents concernés. Ce fichier porte le backlog détaillé ; [resume.md](../resume.md) conserve la synthèse architecturale, [routes.md](../routes.md) le contrat HTTP et [test.md](../test.md) la couverture réellement exécutée.
