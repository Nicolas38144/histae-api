# Sessions mobiles et rotation des clés JWT

Ce guide concerne les sessions mobiles, pas les sessions WebAuthn du dashboard. Le contrat précis des routes
reste dans [routes.md](../routes.md).

## Familles et rejeu

Une connexion OTP crée une `refresh_token_family`. Chaque rotation consomme le token courant, enregistre
`rotated_at` et crée un seul enfant avec `parent_token_id`, dans la même transaction. Un index unique interdit
plusieurs tokens non révoqués dans une famille ; les clés étrangères imposent la propriété utilisateur/famille.
Les mutations verrouillent d'abord `user_account`, puis relisent le token et la famille. La déconnexion globale,
le bannissement et l'enregistrement push utilisent le même ordre de sérialisation.

Le serveur compare le hash du secret avant toute révocation. Rejouer un token réellement consommé, encore dans
sa durée de validité initiale, révoque la famille entière et ses descendants. Un identifiant connu avec un secret
incorrect ne permet pas de déconnecter la victime. Une famille indépendante du même compte n'est pas touchée.
La transaction de révocation est commitée avant de renvoyer le même `401 invalid_or_expired_refresh_token`
que pour un token invalide : ni le secret ni le diagnostic de rejeu ne sont exposés.

Ce mécanisme reprend le principe de détection de rejeu décrit dans la
[RFC 9700, section 4.14.2](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2), sans transformer Histae en serveur OAuth.

## Contrat pour le client mobile

- Le format reste `UUIDv4:secret-base64url` et les réponses OTP/refresh restent `{ access_token, refresh_token }`.
- Un seul refresh peut être en vol par session : partager la même promesse entre les appels HTTP concurrents.
- Remplacer atomiquement les deux tokens dans le stockage sécurisé du téléphone après une réponse réussie.
- Aucun délai de grâce ni rejeu idempotent du refresh : deux demandes avec le même token provoquent une révocation.
- Après une perte de réponse, l'état de consommation est incertain. Ne pas réessayer indéfiniment l'ancien token ;
  une nouvelle connexion OTP peut être nécessaire. Le serveur ne conserve pas de secret permettant de renvoyer l'enfant.
- Sur `401`, ne pas lancer une boucle de refresh, et vider la session locale si le renouvellement est refusé.

Les access tokens incluent `sid` (famille), `typ=access`, `iss`, `aud`, `exp` et un `kid` dans l'en-tête signé.
Le guard relit la famille avec le compte à chaque requête. Une révocation bloque donc les requêtes suivantes,
pas uniquement les futurs renouvellements. Les requêtes déjà en cours ne sont pas annulées rétroactivement.
Les flux SSE se ferment à l'expiration du JWT et recontrôlent la session toutes les 25 secondes ; une révocation
ou une impossibilité de vérifier la session ferme également le flux. Le mobile doit se reconnecter avec son JWT courant.

## Gestion des sessions et appareils

- `GET /api/auth/sessions?limit=20&cursor=…` : sessions actives, dates et indicateur `current`, sans secret, hash,
  adresse IP ou user-agent. `last_refreshed_at` désigne le dernier renouvellement, pas la dernière requête HTTP.
- `DELETE /api/auth/sessions/:id` : révoque une session du compte, y compris la session courante. Répéter la
  suppression d'une autre session encore référencée est idempotent (`204`) ; une session étrangère ou absente vaut `404`.
- `POST /api/auth/logout-all` avec `{ "confirm": true }` : révoque toutes les familles non révoquées du compte,
  session courante comprise, et supprime tous ses enregistrements push. Une nouvelle connexion OTP reste possible.
- `POST /api/auth/logout` conserve son corps actuel. Le refresh présenté doit appartenir à la même famille que
  le Bearer ; un prédécesseur authentique encore non expiré suffit pour gérer un logout concurrent au refresh.

Ces routes restent disponibles pendant l'onboarding et partagent un compteur dédié par utilisateur, avec les
bornes `RATE_LIMIT_REFRESH` / `RATE_LIMIT_REFRESH_WINDOW` (30/15 min par défaut). Le renouvellement public
conserve son compteur séparé par IP.

Un nouvel enregistrement push est lié à la session authentifiée ; sa révocation supprime ce lien et le token FCM.
Les anciens appareils ont `session_id: null` jusqu'au réenregistrement par le client. Un logout ciblé peut toujours
les retirer via `device_id`, et logout-all les retire tous. Une notification déjà envoyée à FCM n'est pas rappelable.

## Conservation, export et effacement

Les tokens consommés gardent uniquement leur hash et leur filiation jusqu'à leur expiration initiale, afin de
détecter le rejeu. Aucun secret brut n'est persisté. La rotation conserve la durée glissante `JWT_REFRESH_TTL`
(180 jours par défaut), sans nouvelle durée de rétention. Les ancêtres expirés sont purgés par lots ; leur lien
parent devient nul sans effacer les enfants. Une famille expirée est supprimée seulement après la purge de ses
tokens, pour ne pas cascader un historique non borné dans une maintenance.

Les métadonnées de famille et le motif normalisé de révocation sont inclus dans l'export utilisateur, sans hashes
de tokens. Elles disparaissent à l'anonymisation ou à la suppression du compte. Les règles restent soumises à la
validation de la politique de conservation avant production.

## Déploiement

Les familles et filiations sont définies dans la [baseline consolidée](postgres-migrations.md).

Déployer de manière coordonnée : arrêter les anciennes instances HTTP/workers, appliquer `pnpm run db:migrate`,
puis démarrer le nouveau code. Un ancien code sans `family_id` ne doit jamais écrire après la
migration. Les anciens JWT sans `sid`/`kid` sont refusés et nécessitent un refresh. Les tokens de `seed:swipes`
utilisent eux aussi une famille temporaire et le contrat JWT courant.

## Rotation HS256 sans fournisseur externe

`JWT_SECRET` reste le secret actif ; `JWT_ACTIVE_KID` vaut `primary` par défaut. `JWT_PREVIOUS_KEYS` est un objet
JSON contenant au plus quatre clés de vérification locales. Les IDs et les secrets doivent être distincts,
chaque secret doit contenir au moins 32 octets et rester distinct des clés téléphone. Générer des secrets aléatoires.

Exemple de forme, sans vraie clé :

```ini
JWT_ACTIVE_KID=key-2026-09
JWT_SECRET=<nouveau-secret-aleatoire>
JWT_PREVIOUS_KEYS={"key-2026-08":"<ancien-secret-aleatoire>"}
```

Pour plusieurs instances :

1. Précharger la nouvelle clé dans le trousseau de vérification de toutes les instances, en gardant la signature ancienne.
2. Basculer `JWT_ACTIVE_KID` et `JWT_SECRET` ; conserver l'ancienne clé dans `JWT_PREVIOUS_KEYS`.
3. Après l'expiration du dernier JWT signé avec l'ancienne clé (ancienne durée maximale + marge d'horloge), retirer cette clé.

En cas de compromission, retirer immédiatement la clé concernée et accepter les `401` des JWT correspondants.
Ne jamais réutiliser le même `kid` pour un autre secret. Le `kid` ne sélectionne qu'une entrée locale : aucun
fichier, JWKS distant ou URL fournie dans le token n'est consulté. L'algorithme reste strictement HS256.
