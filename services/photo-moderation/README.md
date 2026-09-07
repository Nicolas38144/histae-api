# Analyse photo locale

Service optionnel de développement utilisé par `PHOTO_MODERATION_PROVIDER=local_http`. Il analyse un WebP en
mémoire, sans stockage persistant, et renvoie trois signaux : visage détectable, netteté suffisante et contenu autorisé.

## Démarrage

Depuis la racine de l’API :

Après avoir renseigné `PHOTO_MODERATION_TOKEN` dans le `.env` de l’API :

```bash
docker compose --env-file .env -f compose.yaml -f compose.dev.yaml \
  up -d --build --wait photo-moderation
```

Le token doit correspondre à `PHOTO_MODERATION_TOKEN` dans l’API. Le service écoute uniquement sur
`127.0.0.1:8090` et expose un healthcheck.

## Limites

Le détecteur Haar, la variance du Laplacien et le modèle NSFW ONNX servent au triage, pas à établir une certitude.
L’API peut approuver un résultat clairement sûr, mais ne rejette jamais automatiquement. Un signal, un timeout ou
une réponse invalide laisse le contenu privé en attente de revue humaine. La calibration et les recours restent
suivis dans [la roadmap](../../docs/roadmap.md#r09-moderation).
