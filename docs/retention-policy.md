# Politique de conservation technique

Mise à jour : 2 septembre 2026. Propriétaire pressenti : responsable de traitement Histae. Approbateur requis : juriste ou DPO mandaté.

Cette matrice décrit ce que le code applique aujourd’hui. Elle ne constitue pas un avis juridique. Toute mise en production exige une validation documentée et une valeur `LEGAL_REVIEW_REFERENCE` correspondant à cette validation.

| Données | Finalité | Déclencheur et durée | Traitement automatique |
| --- | --- | --- | --- |
| Compte, profil, préférences, traits | Fourniture du service | Vie du compte ; effacement à la suppression ou au retrait du consentement sensible pour les champs concernés | Suppression des tables de profil ; compte technique anonymisé et désactivé |
| Photo de profil privée | Présentation du profil après révélation mutuelle | Jusqu’au remplacement, à la suppression de la photo ou à l’effacement du compte | La ligne `ready` passe à `deleting` et un événement `photo.delete` est écrit dans la même transaction. Le worker outbox supprime l’objet WebP puis la ligne technique ; `PhotosMaintenanceService` reste le filet de réconciliation. Aucune URL signée n’est persistée |
| Idempotence d’upload photo | Rejouer sans double conversion ni double écriture | 24 heures après la demande | `photo_upload_request` conserve UUID utilisateur, UUID de clé, SHA-256 du nom/MIME/contenu source et état technique, jamais les octets de la photo ; purge bornée par `PhotosMaintenanceService` |
| Outbox technique | Garantir les suppressions objet demandées | Événement réussi : 7 jours ; `dead_letter` : jusqu’au diagnostic opérateur | Le worker revendique avec `SKIP LOCKED`, réessaie dix fois avec backoff, purge les succès par lots et conserve les échecs définitifs sans message d’erreur sensible. La relance admin exige un motif et réinitialise l’événement avec une trace `admin_reconcile_photo` |
| Position précise | Découverte locale demandée par l’utilisateur | Fraîche pendant 1 h, supprimée après 24 h ; immédiatement supprimée au retrait du consentement de localisation | `PrivacyMaintenanceService` et transaction de retrait |
| Décisions de swipe (`like`/`pass`) | Exclure les profils déjà évalués et détecter un intérêt réciproque | 1 an fixe (`default_time_to_live = 31536000`) ou effacement immédiat du compte | TTL uniforme sur les deux vues ScyllaDB, avec TWCS par fenêtres de 14 jours ; suppression croisée des partitions acteur/cible lors de l’effacement |
| OTP | Authentification | Jusqu’à `expires_at` ou consommation | Suppression par lots après expiration |
| Refresh tokens | Session | Jusqu’à `expires_at`, révocation, rotation ou effacement du compte | Suppression par lots et suppression immédiate à l’effacement |
| Notifications | Information de l’utilisateur | Jusqu’à `expires_at` (90 jours par défaut dans le schéma) | Suppression par lots |
| Preuves de choix juridiques | Preuve des choix et du consentement explicite | Accord actif pendant le traitement ; événement retiré conservé 5 ans après retrait | IP et user-agent supprimés lors de l’effacement du compte ; événement supprimé par lots après 5 ans |
| Matchs et messages | Mise en relation et conversation | Match actif pendant sa vie métier ; match expiré ou bloqué purgé sous 30 jours | Les messages émis sont masqués immédiatement à l’effacement ; suppression en cascade avec le match |
| Signalements résolus | Sécurité, modération, défense des droits | 3 ans après résolution | Suppression par lots |
| Demandes d’exercice des droits | Traitement et preuve de la demande | 5 ans après clôture ou rejet | Suppression par lots |
| Journal des accès et actions RGPD/modération | Traçabilité et sécurité | 1 an glissant | Suppression par lots |
| Empreinte d’un compte banni effacé | Empêcher le contournement immédiat d’une mesure de sécurité | 3 ans après effacement, seulement si le compte était banni | Empreinte HMAC isolée dans `account_tombstone`, puis suppression par lots |
| Compte technique anonymisé | Intégrité référentielle pendant les délais ci-dessus | Sans téléphone, profil, préférences, position, tokens ni appareil ; les relations résiduelles sont purgées selon leur propre durée | UUID pseudonyme conservé tant qu’une relation légitime le référence |

La durée d’un an des swipes est une valeur produit et technique initiale : elle empêche la réapparition rapide
d’un profil déjà évalué et laisse le temps de détecter un like réciproque. Elle doit être incluse dans la
validation juridique/DPO. Le code échoue en mode fermé : si ScyllaDB n’est pas joignable, un export complet ou
un effacement complet n’est pas déclaré réussi.

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

## Exécution

En développement, `MAINTENANCE_MODE=api` lance la maintenance et le consommateur outbox dans l’API. En production,
utilisez `MAINTENANCE_MODE=disabled` pour l’API, exécutez périodiquement
`MAINTENANCE_MODE=worker pnpm maintenance:run` et gardez au moins un
`MAINTENANCE_MODE=worker pnpm outbox:work` actif. Les traitements sont bornés par lots et protégés par des verrous
PostgreSQL. Les photos restées `processing` plus de 30 minutes sont supprimées comme objets potentiellement
orphelins ; une ligne `deleting` en échec devient réessayable après 5 minutes par le filet de maintenance.
