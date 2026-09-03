# Photo moderation locale

Ce service interne analyse uniquement le WebP déjà décodé et normalisé par l'API. Il combine le classifieur Haar frontal d'OpenCV, la variance du Laplacien pour la netteté et le modèle `open_nsfw` au format ONNX. Ses scores sont des signaux de triage : l'API approuve les résultats clairement sûrs et envoie tous les autres cas en revue humaine.

Il n'accepte pas les fichiers mobiles d'origine, ne conserve aucune image et ne doit pas être exposé à Internet. L'API l'appelle avec un jeton partagé d'au moins 32 octets. Le modèle ONNX d'environ 22 Mo est inclus dans la roue `opennsfw-onnx`; aucun téléchargement n'a lieu au démarrage.

Depuis la racine du dépôt :

```powershell
$env:PHOTO_MODERATION_TOKEN = "un-secret-local-de-32-octets-minimum"
docker compose -f docker-compose.photo-moderation.yml up --build -d
```

Configurer ensuite l'API avec `PHOTO_MODERATION_PROVIDER=local_http`, le même jeton et `PHOTO_MODERATION_ENDPOINT=http://127.0.0.1:8090`. Le seuil de netteté doit être recalibré sur un jeu de photos représentatif avant la production.
