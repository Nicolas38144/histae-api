# Fixtures photo

Ce dossier couvre chacune des extensions acceptées par l’API : `.jpg`, `.jpeg`, `.png`, `.heic`, `.heif` et
`.webp`. Toutes les fixtures restent sous la limite d’entrée de 500 000 octets.

Les tests convertissent chaque fixture en WebP, puis vérifient la limite de sortie, les dimensions persistées et
le SHA-256 enregistré dans `user_photo`. Ces fichiers couvrent l’entrée du processeur, pas des objets destinés au
bucket de développement.

Ils ne portent aucune identité d’idempotence : les tests HTTP génèrent séparément un `Idempotency-Key` UUID v4,
et `photo_upload_request` ne conserve que l’empreinte de la requête pendant 24 heures.

`sample.jpg`, `sample.jpeg`, `sample.png` et `sample.webp` sont générés localement depuis un SVG synthétique par
`pnpm run fixtures:photos`. `sample.heif` est une copie du conteneur HEIF/HEVC de `sample.heic`, avec l’extension
alternative que l’API doit aussi reconnaître.

`sample.heic` provient du corpus public
[`gaberomualdo/heic-jpg-comparison`](https://github.com/gaberomualdo/heic-jpg-comparison/blob/master/heic/1.heic).
Le dépôt source indique utiliser des photos Pixabay sous leur licence libre d’usage. Ne remplacez pas ce fichier
par une photo personnelle ou contenant des métadonnées sensibles.
