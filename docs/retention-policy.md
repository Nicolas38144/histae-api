# Politique de conservation technique

Mise à jour : 4 septembre 2026. Propriétaire pressenti : responsable de traitement Histae. Approbateur requis : juriste ou DPO mandaté.

Cette matrice décrit ce que le code applique aujourd’hui. Elle ne constitue pas un avis juridique. Toute mise en production exige une validation documentée et une valeur `LEGAL_REVIEW_REFERENCE` correspondant à cette validation.

| Données | Finalité | Déclencheur et durée | Traitement automatique |
| --- | --- | --- | --- |
| Compte, profil, préférences, traits et réponses aux questions | Fourniture du service | Vie du compte ; réponses supprimées lors de leur remplacement, de la suppression de leur question ou du compte ; effacement des champs sensibles au retrait du consentement concerné | `user_profile_answer` référence le profil et le catalogue avec `ON DELETE CASCADE` ; suppression du profil lors de l’effacement, puis compte technique anonymisé et désactivé |
| Photo de profil privée | Présentation du profil après approbation et révélation mutuelle | Jusqu’au remplacement, au rejet administratif, à la suppression de la photo ou à l’effacement du compte | La ligne `ready` passe à `deleting` et un événement `photo.delete` est écrit dans la même transaction. Le worker outbox supprime l’objet WebP puis la ligne technique ; `PhotosMaintenanceService` reste le filet de réconciliation. Aucune URL signée n’est persistée |
| Cas, signaux et décisions de modération | Empêcher l’exposition de contenus contraires aux règles et démontrer la revue | Vie du contenu source ; les références bio/réponse disparaissent avec le profil ou la réponse, et la référence photo après suppression confirmée de sa ligne. Le journal séparé de l’accès/revue suit sa durée d’un an | `content_moderation_case` ne conserve pas de copie du texte ou de l’image : seulement la référence source, statut, motifs, politique, scores techniques et décision humaine. Les cascades PostgreSQL l’effacent avec le contenu |
| Idempotence d’upload photo | Rejouer sans double conversion ni double écriture | 24 heures après la demande | `photo_upload_request` conserve UUID utilisateur, UUID de clé, SHA-256 du nom/MIME/contenu source et état technique, jamais les octets de la photo ; purge bornée par `PhotosMaintenanceService` |
| Outbox technique | Garantir les suppressions objet demandées et les intentions de push | Événement réussi ou explicitement abandonné : 7 jours ; `dead_letter` : jusqu’au diagnostic opérateur | Le worker revendique avec `SKIP LOCKED`, réessaie dix fois avec backoff et purge les événements résolus par lots. Relance et abandon exigent une authentification admin récente, un motif et un audit transactionnel. Un `photo.delete` ne peut être abandonné tant que sa ligne photo existe. `notification.push` contient un payload vide ; son abandon ne supprime pas la notification |
| Actions opérateur outbox | Traçabilité des reprises et abandons techniques | 1 an glissant | Identité/role au moment de l’action, type d’événement et motif, sans payload ni clé objet ; suppression bornée par `PrivacyMaintenanceService` |
| Position précise | Découverte locale demandée par l’utilisateur | Fraîche pendant 1 h, supprimée après 24 h ; immédiatement supprimée au retrait du consentement de localisation | `PrivacyMaintenanceService` et transaction de retrait |
| Décisions de swipe (`like`/`pass`) | Exclure les profils déjà évalués et détecter un intérêt réciproque | 1 an fixe (`default_time_to_live = 31536000`) ou effacement immédiat du compte | TTL uniforme sur les deux vues ScyllaDB, avec TWCS par fenêtres de 14 jours ; suppression croisée des partitions acteur/cible lors de l’effacement |
| OTP | Authentification | Jusqu’à `expires_at` ou consommation | Suppression par lots après expiration |
| Refresh tokens et familles mobiles | Session et détection du rejeu | Hash et filiation de chaque token conservés jusqu'à son `expires_at` initial, même après rotation/révocation ; famille jusqu'à l'expiration de son dernier token puis purge de ses tokens ; effacement immédiat du compte | Les ancêtres expirés sont purgés par lots sans effacer leurs enfants. Les familles expirées sont purgées seulement une fois vides. L'export contient les métadonnées de famille et le motif normalisé de révocation, jamais les hashes. Aucun secret brut, IP ou user-agent n'est ajouté |
| Challenges et jetons d’enrôlement WebAuthn admin | Authentification forte du dashboard | Challenge : 5 minutes ; enrôlement initial : 15 minutes par défaut ; consommation unique | Seuls les hashes SHA-256 des secrets sont conservés. Suppression bornée dès consommation ou expiration |
| Credentials WebAuthn admin | Authentification forte et récupération | Vie du compte administratif ou révocation explicite | Clé publique, compteur, transports et métadonnées minimales seulement ; les clés privées restent dans l’authenticator. La dernière passkey active et celle de la session courante ne sont pas révocables |
| Sessions administrateur | Session du dashboard | 30 minutes d’inactivité, 8 heures absolues par défaut ; session révoquée conservée au plus 24 heures | Jeton aléatoire de 256 bits stocké uniquement sous forme de hash SHA-256 ; cookie `HttpOnly`; purge par lots après expiration absolue ou délai de révocation |
| Journal d’authentification administrateur | Traçabilité de sécurité | 1 an glissant | Événements sans secret ni clé publique ; suppression par lots |
| Notifications | Information de l’utilisateur | Jusqu’à `expires_at` (90 jours par défaut dans le schéma) | Suppression par lots et nettoyage final à la désactivation du compte, y compris pour une écriture concurrente ; clé de déduplication hashée, référence de facture/abonnement et fin d’essai internes pour écarter les alertes obsolètes, aucune copie de texte privé |
| Références de livraison push | Reprise indépendante des envois par appareil | Jusqu’à la suppression de la notification, de l’appareil ou de l’événement outbox résolu, selon le premier déclencheur | Cascade PostgreSQL sur ces trois références ; UUID techniques et session ciblée uniquement, aucun token FCM recopié. Une référence disparue rend la tâche inopérante, même après relance administrative |
| Preuves de choix juridiques | Preuve des choix et du consentement explicite | Accord actif pendant le traitement ; événement retiré conservé 5 ans après retrait | IP et user-agent supprimés lors de l’effacement du compte ; événement supprimé par lots après 5 ans |
| Matchs et messages | Mise en relation et conversation | Match actif pendant sa vie métier ; match expiré ou bloqué purgé sous 30 jours | Les messages émis sont masqués immédiatement à l’effacement ; suppression en cascade avec le match |
| Signalements résolus | Sécurité, modération, défense des droits | 3 ans après résolution | Suppression par lots |
| Demandes d’exercice des droits | Traitement et preuve de la demande | 5 ans après clôture ou rejet | Suppression par lots |
| Progression d’effacement (`account_erasure`) | Reprise et preuve de terminaison | Même rétention que la DSR associée : suppression en cascade, 5 ans après clôture | Étape, progression et dates uniquement ; aucune réponse fournisseur. Une demande inachevée n’est pas purgée comme terminée. `account.erase` suit la rétention outbox et ne peut jamais être abandonné |
| Journal des accès et actions RGPD/modération | Traçabilité et sécurité | 1 an glissant | Suppression par lots |
| Empreinte d’un compte banni effacé | Empêcher le contournement immédiat d’une mesure de sécurité | 3 ans après effacement, seulement si le compte était banni | Empreinte HMAC isolée dans `account_tombstone`, puis suppression par lots |
| Compte technique anonymisé | Intégrité référentielle pendant les délais ci-dessus | Sans téléphone, profil, préférences, position, tokens ni appareil ; les relations résiduelles sont purgées selon leur propre durée | UUID pseudonyme conservé tant qu’une relation légitime le référence |

La durée d’un an des swipes est une valeur produit et technique initiale : elle empêche la réapparition rapide
d’un profil déjà évalué et laisse le temps de détecter un like réciproque. Elle doit être incluse dans la
validation juridique/DPO. Le code échoue en mode fermé : si ScyllaDB n’est pas joignable, un export complet ou
un effacement complet n’est pas déclaré réussi.

Depuis R02, l’acceptation de l’effacement désactive immédiatement le compte, mais répond `202`, pas « terminé ».
Les nouvelles mutations et projections publiques sont bloquées ; les suppressions Stripe, photos, Scylla puis
PostgreSQL se poursuivent avec checkpoints et reprises. Les positions peuvent toujours être rendues inactives
ou purgées par la maintenance. Les règles de conservation du tableau restent inchangées : « effacement du
compte » désigne le workflow complet, pas un délai garanti de réponse HTTP. Les anciennes URL photo déjà
signées restent limitées par leur expiration de 300 secondes ou la suppression de l’objet ; les copies déjà
téléchargées ne sont pas révocables par l’API.

Les intentions de création Customer Stripe sont conservées avec leurs tentatives Checkout jusqu’à
l’anonymisation, afin qu’une réponse perdue ne fasse pas disparaître une référence à nettoyer. Une issue trop
ancienne pour un rejeu idempotent sûr reste à réconcilier et bloque la clôture. Voir [le protocole R02](account-erasure.md).

La vue Scylla orientée cible conserve les références entrantes afin de détecter la réciprocité et de supprimer
toutes les références croisées lors d’un effacement. Elle reste strictement interne : l’export utilisateur ne
communique que les décisions prises par cet utilisateur, jamais l’identité ni le choix des autres membres.

## Fondements à faire approuver

- Le RGPD impose la minimisation, une conservation limitée et la capacité à démontrer le consentement : [articles 5 et 7 du RGPD](https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=fr).
- La CNIL recommande en général de conserver les journaux entre six mois et un an, sauf justification documentée : [Sécurité : tracer les opérations](https://www.cnil.fr/fr/securite-tracer-les-operations).
- La CNIL rappelle que le consentement explicite est normalement requis pour les données sensibles pertinentes d’un service de rencontres : [questions-réponses sur les activités commerciales](https://www.cnil.fr/fr/questions-reponses-sur-les-referentiels-relatifs-la-gestion-des-activites-commerciales-et-des).
- La durée de cinq ans utilisée pour les preuves et demandes clôturées doit être confirmée pour Histae ; elle est cohérente avec la prescription civile de droit commun de [l’article 2224 du Code civil](https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000019017112/) et avec la pratique publiée par la CNIL pour ses propres dossiers de droits, mais ce rapprochement est une analyse technique, pas une validation juridique.

## Points nécessitant une décision externe

1. Confirmer la base légale et la durée de trois ans des signalements et tombstones de bannissement.
2. Confirmer que les catégories `sex` et `looking_for` sont correctement qualifiées, expliquées et limitées aux finalités affichées.
3. Définir une politique pour les comptes durablement inactifs et son processus de préavis ; aucune suppression automatique d’un compte actif n’est actuellement déclenchée sans demande de l’utilisateur.
4. Confirmer les destinataires, sous-traitants, transferts, sauvegardes et délais de restauration/purge dans les sauvegardes.
5. Valider la rédaction exacte des CGU, de la notice de confidentialité et des écrans de consentement mobile.
6. Confirmer la durée d’un an des décisions `like` et `pass`, ou définir deux durées distinctes si la finalité le justifie.
7. Choisir la cible objet de production, sa région, son chiffrement, sa redondance et le délai d’effacement des copies et sauvegardes ; SeaweedFS `weed mini` reste limité au développement local.
8. Valider la durée des métadonnées de modération, la transparence envers les utilisateurs, les habilitations des reviewers et la procédure de contestation d’une décision.

## Exécution

Le seuil de purge de l’outbox résolue reste de 7 jours. Le worker continu ne purge actuellement que 50 événements
par heure : le délai effectif peut dépasser ce seuil si le flux excède sa capacité. R06 dans `roadmap.md` suit
ce défaut de débit, sans décision de prolonger la rétention.

En développement, `MAINTENANCE_MODE=api` lance la maintenance et le consommateur outbox dans l’API. En production,
utilisez `MAINTENANCE_MODE=disabled` pour l’API, exécutez périodiquement
`MAINTENANCE_MODE=worker pnpm maintenance:run` et gardez au moins un
`MAINTENANCE_MODE=worker pnpm outbox:work` actif. Les traitements sont bornés par lots et protégés par des verrous
PostgreSQL. Les photos restées `processing` plus de 30 minutes sont supprimées comme objets potentiellement
orphelins ; une ligne `deleting` en échec devient réessayable après 5 minutes par le filet de maintenance.
