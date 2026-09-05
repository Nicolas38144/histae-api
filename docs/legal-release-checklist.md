# Validation juridique avant production

Cette checklist structure les décisions à obtenir ; elle ne constitue pas un avis juridique. L’API refuse de
démarrer en production si les versions juridiques requises ou `LEGAL_REVIEW_REFERENCE` manquent. Cette présence
prouve seulement qu’une référence a été fournie, pas qu’elle est valable.

## Textes, finalités et droits

- [ ] Faire approuver CGU, notice de confidentialité, consentement aux données sensibles et consentement de localisation.
- [ ] Documenter finalités, bases légales, destinataires, transferts et durées.
- [ ] Vérifier si une AIPD est requise pour données sensibles, géolocalisation et mise en relation.
- [ ] Garantir des consentements facultatifs, séparés, non précochés, compréhensibles et aussi faciles à retirer qu’à donner.
- [ ] Valider contrôle d’identité, délai de réponse, protection des tiers dans l’export et refus motivé.
- [ ] Définir le traitement des comptes durablement inactifs et le préavis éventuel.

## Conservation et effacement

- [ ] Approuver la matrice [retention-policy.md](retention-policy.md), y compris signalements, tombstones,
  swipes, notifications, sessions, OTP et audits.
- [ ] Valider la conservation des hashes de refresh consommés nécessaire à la détection de rejeu.
- [ ] Valider les métadonnées Sweego minimales, sans téléphone, OTP ou payload webhook conservé.
- [ ] Définir les sauvegardes, leur accès, leur rétention et la purge des données restaurées après effacement.
- [ ] Vérifier l’effacement Stripe, PostgreSQL, ScyllaDB et stockage objet, ainsi que le traitement des dead letters.

## Profil, photos et modération

- [ ] Approuver les questions initiales et la gouvernance des ajouts administratifs.
- [ ] Informer de la visibilité des réponses et de leur suppression avec une question.
- [ ] Approuver catégories, versions, règles automatisées, décisions humaines et procédure de recours.
- [ ] Mesurer et documenter faux positifs, faux négatifs et biais sur un corpus représentatif.
- [ ] Définir habilitations, formation, soutien et exposition minimale des reviewers.
- [ ] Interdire le rejet entièrement automatisé et ne jamais présenter un score probabiliste comme une certitude.

## Fournisseurs et infrastructure

- [ ] Documenter sous-traitants, régions, transferts, chiffrement, habilitations et clauses contractuelles.
- [ ] Choisir la cible objet de production et valider sauvegarde, restauration et suppression des copies.
- [ ] Inventorier SDK AWS v3, Sharp/libvips, `heic-decode`, OpenCV, FastAPI et modèle ONNX ;
  vérifier licences, provenance, intégrité et suivi de sécurité.
- [ ] Valider les données minimales transmises à Sweego, FCM et Stripe.

## Administration et preuve

- [ ] Exiger deux passkeys distinctes par administrateur et encadrer l’enrôlement/récupération hors bande.
- [ ] Définir révocation lors d’un départ, revue des événements et conservation des traces.
- [ ] Valider la durée, les habilitations et le gel d’incident définis dans la [politique de journalisation](logging-policy.md).
- [ ] Enregistrer chaque approbation dans un support durable indiquant auteur, date, périmètre et contenu.
- [ ] Placer son identifiant vérifiable dans `LEGAL_REVIEW_REFERENCE`.
- [ ] Incrémenter toute version juridique modifiée afin que le mobile la représente à l’utilisateur.

Une valeur générique telle que `approved`, une date seule ou une référence inventée ne satisfait pas cette checklist.
