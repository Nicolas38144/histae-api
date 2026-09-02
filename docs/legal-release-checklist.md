# Validation juridique avant production

L’API refuse de démarrer en production si une version manque pour les CGU, la notice de confidentialité, le consentement aux données sensibles ou le consentement de localisation, ou si `LEGAL_REVIEW_REFERENCE` est vide. Ce verrou prouve qu’une référence a été fournie ; il ne prouve pas que l’avis est valide.

Avant chaque nouvelle version juridique :

- faire approuver les quatre textes, les finalités, bases légales, destinataires et durées par le juriste/DPO ;
- vérifier la nécessité d’une AIPD, particulièrement au regard des données sensibles, de la géolocalisation et de la mise en relation ;
- valider que les consentements sensibles et de localisation sont facultatifs, séparés, non précochés, compréhensibles et retirables aussi facilement qu’ils sont donnés ;
- vérifier les procédures de réponse sous un mois, de contrôle d’identité proportionné, de protection des tiers dans l’export et de refus motivé ;
- valider la matrice [`retention-policy.md`](retention-policy.md), y compris les sauvegardes et sous-traitants ;
- documenter l’hébergeur objet de production, sa région, les transferts éventuels, le chiffrement, les habilitations, les sauvegardes, la purge des photos remplacées ou supprimées, la rétention de 24 h des empreintes d’idempotence et le traitement des dead letters `photo.delete` ;
- intégrer `sharp`/libvips, `heic-decode`/libheif-js et le SDK AWS v3 à l’inventaire des composants et vérifier leurs licences et mises à jour de sécurité avant livraison ;
- enregistrer l’approbation dans un système durable (ticket signé, procès-verbal ou registre DPO) et placer son identifiant dans `LEGAL_REVIEW_REFERENCE` ;
- incrémenter toute version de texte modifiée afin que l’application mobile la représente à l’utilisateur.

Une valeur telle que `approved`, une date seule ou une référence inventée ne doit pas être acceptée dans le processus de déploiement. L’identifiant doit permettre de retrouver l’auteur, la date, le périmètre et le contenu approuvé.
