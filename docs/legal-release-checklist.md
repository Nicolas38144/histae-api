# Validation juridique avant production

L’API refuse de démarrer en production si une version manque pour les CGU, la notice de confidentialité, le consentement aux données sensibles ou le consentement de localisation, ou si `LEGAL_REVIEW_REFERENCE` est vide. Ce verrou prouve qu’une référence a été fournie ; il ne prouve pas que l’avis est valide.

Avant chaque nouvelle version juridique :

- faire approuver les quatre textes, les finalités, bases légales, destinataires et durées par le juriste/DPO ;
- vérifier la nécessité d’une AIPD, particulièrement au regard des données sensibles, de la géolocalisation et de la mise en relation ;
- valider que les consentements sensibles et de localisation sont facultatifs, séparés, non précochés, compréhensibles et retirables aussi facilement qu’ils sont donnés ;
- vérifier les procédures de réponse sous un mois, de contrôle d’identité proportionné, de protection des tiers dans l’export et de refus motivé ;
- valider la matrice [`retention-policy.md`](retention-policy.md), y compris les sauvegardes et sous-traitants ;
- inclure les références de livraison push par appareil, leur suppression en cascade et le contexte de facture/abonnement interne servant à écarter les alertes obsolètes ; R01 ne change pas les durées de notification/outbox/audit et ne copie ni token FCM ni texte privé dans les tâches ;
- inclure les métadonnées des familles mobiles et les motifs normalisés de révocation dans cette validation ; les hashes des tokens consommés restent conservés jusqu'à leur expiration initiale pour détecter le rejeu, sans nouvelle durée ni collecte d'IP/user-agent ;
- faire approuver les questions de profil initiales et la gouvernance des ajouts administratifs, interdire les
  formulations qui solliciteraient inutilement des données sensibles, informer que les réponses sont visibles aux
  autres membres et vérifier que la suppression d’une question et de toutes ses réponses est compatible avec les
  procédures de modération, d’export et d’effacement ;
- faire approuver la politique de modération, ses catégories et ses versions ; informer clairement l’utilisateur
  des contrôles automatisés, de l’état de son contenu, de la décision humaine éventuelle et d’un moyen de la
  contester, sans présenter un score probabiliste comme une certitude ;
- évaluer et documenter les faux positifs, faux négatifs et biais du comptage de visages, du score de netteté, du
  classifieur NSFW et des règles linguistiques sur un corpus représentatif des membres ; maintenir une revue
  humaine et interdire tout rejet entièrement automatisé ;
- définir les habilitations, la formation et le soutien des reviewers, le délai de traitement, la minimisation de
  l’exposition au contenu sensible et la conservation des motifs/audits ;
- documenter l’hébergeur objet de production, sa région, les transferts éventuels, le chiffrement, les habilitations, les sauvegardes, la purge des photos remplacées ou supprimées, la rétention de 24 h des empreintes d’idempotence et le traitement des dead letters `photo.delete`, y compris les habilitations et motifs de relance `admin_reconcile_photo` ;
- faire approuver la gouvernance des comptes administratifs : deux passkeys distinctes par personne, contrôle de
  l’accès à la commande d’enrôlement, procédure de récupération hors bande, révocation lors d’un départ et revue
  des événements de connexion, renommage et révocation conservés un an ;
- intégrer `sharp`/libvips, `heic-decode`/libheif-js, le SDK AWS v3, OpenCV, FastAPI et le modèle ONNX de modération
  à l’inventaire des composants ; vérifier leurs licences, provenance, intégrité et mises à jour de sécurité avant livraison ;
- enregistrer l’approbation dans un système durable (ticket signé, procès-verbal ou registre DPO) et placer son identifiant dans `LEGAL_REVIEW_REFERENCE` ;
- incrémenter toute version de texte modifiée afin que l’application mobile la représente à l’utilisateur.

Une valeur telle que `approved`, une date seule ou une référence inventée ne doit pas être acceptée dans le processus de déploiement. L’identifiant doit permettre de retrouver l’auteur, la date, le périmètre et le contenu approuvé.
