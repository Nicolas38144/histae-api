# Fixtures photo

Ce dossier contient les six extensions acceptées : `.jpg`, `.jpeg`, `.png`, `.heic`, `.heif` et
`.webp`. Chaque source reste sous 500 000 octets.

## Génération

`pnpm run fixtures:photos` régénère `sample.jpg`, `sample.jpeg`, `sample.png` et `sample.webp` depuis
un SVG synthétique. `sample.heif` est une copie du conteneur de `sample.heic` afin de tester l’extension alternative.

`sample.heic` provient du corpus public
[`gaberomualdo/heic-jpg-comparison`](https://github.com/gaberomualdo/heic-jpg-comparison/blob/master/heic/1.heic),
qui indique utiliser des images Pixabay. Ne pas le remplacer par une photo personnelle ou porteuse de métadonnées sensibles.

## Couverture

Les tests vérifient décodage, conversion WebP, taille de sortie, dimensions et SHA-256 persisté. Les fixtures ne
sont pas destinées au bucket de développement et ne portent aucune identité d’idempotence : les tests HTTP créent
leurs propres clés UUID v4.
