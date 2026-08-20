# Histae API — routes existantes

Mise à jour : 17 août 2026. Toutes les routes ci-dessous sont préfixées par `/api`.

## Documentation OpenAPI

Lorsque `OPENAPI_ENABLED=true` (par défaut en développement et en test), l’interface Swagger est disponible à `GET /docs` et son document machine à `GET /docs-json`. Ces routes ne sont pas préfixées par `/api` et sont désactivées par défaut en production.

## Conventions

- Les requêtes avec corps utilisent JSON. Les champs non documentés sont refusés.
- Taille maximale d’un corps JSON : **1 Mio**.
- Les erreurs suivent le format `{ "error": { "code", "message" } }`.
- Une route « authentifiée » requiert `Authorization: Bearer <access_token>`. Le compte doit être non supprimé et non banni. Pour un utilisateur, les CGU et la notice de confidentialité courantes doivent aussi être enregistrées ; sinon la route renvoie `403 onboarding_incomplete`.
- Pendant l'onboarding, `GET|PUT /users/me/consents`, `POST /auth/logout` et `DELETE /users/me` restent accessibles. Les comptes administrateur sont exemptés de l'onboarding utilisateur.
- Une route « admin » accepte les rôles `admin` et `superadmin`.
- `limit` est un entier de 1 à 100 (20 par défaut). Les listes volumineuses renvoient `next_cursor`; passez-le ensuite dans `cursor`. `offset` reste accepté pour compatibilité, mais est déprécié et doit valoir `0` avec un curseur.
- Un rate limit global par IP est actif et partagé dans Redis entre les instances de l’API. Les clés Redis sont pseudonymisées par HMAC. En cas de dépassement : `429 rate_limit_exceeded` avec l’en-tête `Retry-After` ; Redis indisponible produit `503 rate_limit_unavailable`.
- `X-Request-ID` est renvoyé dans chaque réponse. Un UUID valide fourni par le client est conservé.

## Authentification

| Méthode | Route | Accès | Entrée | Résultat |
| --- | --- | --- | --- | --- |
| POST | `/auth/otp/send` | Public | En-tête obligatoire `Idempotency-Key: <UUID v4>` et `{ "phone_number": "+336…" }`. Seuls les numéros français `+33` sont acceptés. | `202 { "message": "Verification code request accepted." }` après acceptation de la demande. Une clé absente ou mal formée renvoie `400 invalid_idempotency_key`; sa réutilisation pour un autre numéro renvoie `409 idempotency_key_conflict`. Une erreur ou une réponse Sweego invalide renvoie `503 otp_delivery_unavailable`. Limite : 5/h par IP et par numéro pseudonymisé. |
| POST | `/auth/otp/verify` | Public | `{ "phone_number": "+336…", "otp": "123456" }`, numéro français `+33` uniquement | `200` avec `{ "access_token", "refresh_token" }`. Le code OTP est consommé une seule fois. Si le téléphone n’est associé à aucun compte, un compte de rôle `user` est créé. Limite : 5/h par IP et numéro pseudonymisé. |
| POST | `/auth/refresh` | Public | `{ "refresh_token": "jti:secret" }` | `200` avec une nouvelle paire de tokens. Le token utilisé est révoqué dans la même transaction. Limite : 30/15 min/IP. |
| POST | `/auth/logout` | Authentifiée | `{ "refresh_token": "jti:secret" }` | `204`, révoque le refresh token s’il appartient à l’utilisateur courant. |

Pour l’envoi OTP, l’API persiste d’abord un hash avec l’état `pending`, appelle l’endpoint transactionnel Sweego, puis passe le code à `sent` uniquement après une réponse HTTP `200` contenant un `transaction_id` et un identifiant `swg_uids` valides. Rejouer rapidement la même clé lorsque la demande est `pending`, ou rejouer une demande déjà `sent`, renvoie le même `202` sans second appel fournisseur. Un `pending` plus ancien que le timeout Sweego augmenté de cinq secondes est marqué `failed` lors du retry et renvoie `503`, comme toute autre demande échouée. L’activation est sérialisée par téléphone et la base garantit qu’un seul OTP envoyé reste utilisable. La durée de validité est définie par `OTP_TTL`.

Le 17 août 2026, ce contrat a été validé manuellement avec Sweego réel : envoi vers un numéro français, retry de la même clé sans second SMS, vérification du code, accès Bearer, rotation du refresh token avec refus de l’ancien et logout `204`.

Les access tokens utilisent HS256 et expirent selon `JWT_ACCESS_TTL`; les refresh tokens suivent `JWT_REFRESH_TTL`. Les erreurs d’authentification les plus courantes sont `authentication_required`, `invalid_or_expired_access_token`, `invalid_or_expired_refresh_token`, `invalid_idempotency_key`, `idempotency_key_conflict`, `otp_delivery_unavailable`, `otp_rate_limit_exceeded` et `refresh_rate_limit_exceeded`.

## Plans

| Méthode | Route | Accès | Résultat |
| --- | --- | --- | --- |
| GET | `/plans` | Public | `200 { "plans": [...] }`. Chaque plan expose son code, nom, prix mensuel/annuel, devise, jours d’essai, éventuelle limite hebdomadaire et fonctionnalités. |

## Console d’administration

Toutes ces routes exigent un compte `admin` ou `superadmin`. Les consultations de données personnelles et les actions de sûreté sont inscrites dans `data_access_log`. Les numéros de téléphone, leurs empreintes et les coordonnées précises ne sont jamais exposés au dashboard.

| Méthode | Route | Corps / paramètres | Résultat |
| --- | --- | --- | --- |
| GET | `/admin/me` | — | `200 { "user_id", "role" }`. Sert à vérifier le rôle après l’authentification OTP. |
| GET | `/admin/metrics` | — | Synthèse des comptes, files de modération, matchs, messages et abonnements. Les indicateurs ne contiennent aucune donnée personnelle. |
| GET | `/admin/users` | `status=active\|banned`, `role=user\|admin\|superadmin`, `search` optionnels ; `limit`, `cursor` (`offset` déprécié) | `200 { "users": [...], "next_cursor" }`. La recherche porte sur le prénom ou un UUID exact. Aucun téléphone n’est retourné. |
| GET | `/admin/users/:id` | UUID ; `reason` obligatoire (3 à 500 caractères) | Détail administratif : compte, profil, préférences, traits, dernier état de consentement et fraîcheur de présence sans coordonnées. L’accès est journalisé. |
| PATCH | `/admin/users/:id/status` | `{ "is_banned", "reason"?: "…" }`. Le motif est obligatoire pour bannir. | Bannit ou débannit le compte. Un bannissement révoque immédiatement tous ses refresh tokens. Un admin ne peut agir que sur un rôle `user`; un superadmin ne peut agir ni sur lui-même ni sur un autre superadmin. |
| GET | `/admin/matches/:id/messages` | UUID ; `reason` obligatoire ; `limit`, `cursor` (`offset` déprécié) | Conversation paginée pour modération. L’accès est journalisé pour les deux participants. |

Les administrateurs s’authentifient par les mêmes routes OTP que les autres comptes. Le dashboard vérifie ensuite le rôle avec `/admin/me` et refuse toute session qui n’est pas administrative.

## Compte utilisateur

Toutes ces routes sont authentifiées.

| Méthode | Route | Corps / paramètres | Résultat |
| --- | --- | --- | --- |
| GET | `/users/me` | — | `200` avec `user_id`, `firstname`, `birthdate` et, lorsqu’ils existent, `sex`, `bio`, `photo`. Retourne `404 profile_not_found` tant que le profil n’est pas complété. |
| PATCH | `/users/me/profile` | `{ "firstname", "birthdate", "sex"?: "male\|female\|other\|null", "bio"?: "…\|null", "photo"?: "http(s)://…\|null" }` | `200 { "message": "profile updated" }`. `firstname` (100 octets max) et `birthdate` au format calendrier strict `YYYY-MM-DD` sont requis ; l’utilisateur doit avoir au moins 18 ans. Bio : 2 000 octets max ; URL photo : 2 048 octets max. |
| GET | `/users/me/preferences` | — | `200` avec `min_age`, `max_age`, `max_distance_km`, `looking_for`; ou `404 preferences_not_found`. |
| PATCH | `/users/me/preferences` | `{ "min_age", "max_age", "max_distance_km", "looking_for" }` | `200 { "message": "preferences updated" }`. Âges entiers 18–99, distance entière 1–500, et `looking_for` vaut `male`, `female`, `both` ou `other`. |
| PATCH | `/users/me/presence` | `{ "latitude", "longitude" }` | `200 { "message": "presence updated" }`. Latitude : -90 à 90 ; longitude : -180 à 180. |
| DELETE | `/users/me` | — | `204`. Efface immédiatement profil, préférences, traits, localisation, tokens, appareils, notifications, blocages, abonnement et swipes Scylla entrants/sortants ; retire les consentements et leurs métadonnées réseau ; anonymise le compte et les messages émis ; clôt les matchs avant purge différée. Si l’effacement Scylla ne peut pas être garanti : `503 data_erasure_unavailable`. |
| GET | `/users/me/continuation-quota` | — | `200` avec le plan effectif, l’usage et, pour un plan limité, `weekly_limit` et `remaining`. |

### Consentements

| Methode | Route | Corps / parametres | Resultat |
| --- | --- | --- | --- |
| GET | `/users/me/consents` | - | `200 { "consents": [...], "onboarding_complete", "required_actions": [...] }`. Chaque choix expose la version acceptée éventuelle, `required_document_version` et `document_url`, afin que le mobile présente exactement le texte attendu. Les preuves techniques (IP, user-agent) ne sont jamais exposées. |
| PUT | `/users/me/consents` | `{ "consents": [{ "consent_type", "granted" }] }` | Renvoie le même état enrichi. Un type ne peut figurer qu'une fois. Les quatre textes utilisent leur version configurée côté serveur. Retirer `sensitive_data_consent` supprime sexe et préférences ; retirer `location_consent` supprime la présence. Un retry identique est idempotent. |

Les types sont `terms_of_service_acceptance`, `privacy_notice_acknowledgement`, `sensitive_data_consent` et `location_consent`. Il n'existe aucun choix marketing. L'acceptation des CGU et l'accusé de présentation ne peuvent pas être retirés via cet endpoint : l'utilisateur peut refuser de les fournir pendant l'inscription ou supprimer son compte. Toute route utilisateur protégée exige les deux premiers choix dans leur version courante ; sexe/préférences exigent en plus `sensitive_data_consent`, et la présence exige `location_consent`. Le guard global renvoie `403 onboarding_incomplete` ; un traitement spécifique sans son consentement renvoie `403 required_consent_missing`.

### Vie privée, droits et blocages

| Méthode | Route | Accès | Corps / paramètres | Résultat |
| --- | --- | --- | --- | --- |
| POST | `/users/me/data-subject-requests` | Authentifiée, onboarding incomplet accepté | `{ "type": "access\|erasure\|portability\|rectification\|restriction\|objection" }` | `201` avec la demande. Une seule demande ouverte par utilisateur et par type. |
| GET | `/users/me/data-subject-requests` | Authentifiée, onboarding incomplet accepté | — | `200 { "requests": [...] }`. |
| GET | `/users/me/data-export` | Authentifiée, onboarding incomplet accepté | — | `200` avec les données PostgreSQL et uniquement les décisions de swipe prises par l’utilisateur. Limite : 5/h/utilisateur, puis `429 data_export_rate_limit_exceeded`. L’export est journalisé. Si l’une des sources nécessaires est indisponible : `503 data_export_unavailable`. |
| GET | `/users/me/blocks` | Authentifiée | — | `200 { "blocks": [...] }`. |
| POST | `/users/me/blocks/:userId` | Authentifiée | UUID utilisateur | `204`. Clôt immédiatement les matchs entre les deux comptes et empêche leur recréation. |
| DELETE | `/users/me/blocks/:userId` | Authentifiée | UUID utilisateur | `204`. |
| GET | `/admin/data-subject-requests` | Admin | `status` optionnel | Liste de traitement, 500 résultats maximum. |
| PATCH | `/admin/data-subject-requests/:id` | Admin | `{ "status": "in_progress\|completed\|rejected", "notes"?: "…" }` | Applique une transition contrôlée et journalisée. Terminer une demande d’effacement déclenche l’anonymisation complète. |
| GET | `/admin/data-access-logs` | Admin | `user_id` | `200 { "logs": [...] }`, 500 résultats maximum. |

## Traits

| Méthode | Route | Accès | Corps / paramètres | Résultat |
| --- | --- | --- | --- | --- |
| GET | `/traits` | Authentifiée | — | `200 { "traits": [{ "id", "name" }] }`. |
| POST | `/users/me/traits` | Authentifiée | `{ "trait_id": "uuid" }` | `204`. Trait absent : `404 trait_not_found`. L’opération est idempotente pour une attribution déjà existante. |
| DELETE | `/users/me/traits/:traitId` | Authentifiée | UUID | `204`. L’opération est idempotente si le trait n’était pas attribué. |
| POST | `/admin/traits` | Admin | `{ "name": "…" }` | `201 { "id", "name" }`. Nom non vide, 100 octets maximum ; doublon : `409 trait_already_exists`. |
| PATCH | `/admin/traits/:id` | Admin | `{ "name": "…" }` | `200 { "message": "trait updated" }`. |
| DELETE | `/admin/traits/:id` | Admin | UUID | `204`. Cette version supprime physiquement le trait. |

## Signalements

| Méthode | Route | Accès | Corps / paramètres | Résultat |
| --- | --- | --- | --- | --- |
| POST | `/reports` | Authentifiée | `{ "reported_user_id": "uuid", "match_id"?: "uuid\|null", "reason": "inappropriate_content\|fake_profile\|harassment\|spam\|other", "description"?: "…\|null" }` | `201` avec le signalement. Auto-signalement interdit ; la cible doit exister. La description est limitée à 2 000 octets. Un match fourni doit relier les deux utilisateurs. Limite : 5/h/utilisateur par défaut. |
| GET | `/admin/reports` | Admin | `status` optionnel : `pending`, `reviewed`, `dismissed`; `limit`, `cursor` (`offset` déprécié) | `200 { "reports": [...], "next_cursor": "…\|null" }`, tri antéchronologique. |
| PATCH | `/admin/reports/:id` | Admin | `{ "status": "pending\|reviewed\|dismissed" }` | `200 { "message": "report updated" }`, ou `404 report_not_found`. |

## Matchs et messagerie

| Méthode | Route | Accès | Corps / paramètres | Résultat |
| --- | --- | --- | --- | --- |
| GET | `/matches/me` | Authentifiée | `limit`, `cursor` (`offset` déprécié) | `200 { "matches": [...], "next_cursor": "…\|null" }`, triés par activité. |
| GET | `/matches/:userId` | Admin | UUID utilisateur ; `reason` obligatoire (3 à 500 caractères) ; `limit`, `cursor` (`offset` déprécié) | Même réponse paginée pour l’utilisateur ciblé. La consultation est inscrite dans `data_access_log`. |
| PATCH | `/matches/:id/reveal` | Authentifiée | — | `200` avec `{ "message", "photos_revealed" }`. Chaque participant enregistre son consentement ; `photos_revealed` devient vrai quand les deux ont consenti. |
| PATCH | `/matches/:id/continue` | Authentifiée | — | `200` avec `{ "message", "match_confirmed" }`. Disponible après la fenêtre initiale de 24 h, puis demande le consentement des deux participants. Le quota hebdomadaire est débité lorsque le second consentement confirme le match. |
| GET | `/matches/:id/messages` | Authentifiée | UUID match ; `limit`, `cursor` (`offset` déprécié) | `200 { "messages": [...], "next_cursor": "…\|null" }`. Le demandeur doit participer au match. |
| POST | `/matches/:id/messages` | Authentifiée | `{ "content": "…" }` | `201` avec le message créé. Contenu non vide, 2 000 caractères maximum. Limite : 60/min/utilisateur, puis `429 message_rate_limit_exceeded`. |
| PATCH | `/matches/:id/messages/:msgId/read` | Authentifiée | UUID match et UUID message | `200 { "message": "message marked as read" }`. Un expéditeur ne peut pas marquer son propre message comme lu. |

Un match est initialement `active` pendant 24 h. Il passe ensuite à `awaiting_continuation`, puis à `confirmed` si les deux utilisateurs acceptent, ou à `expired` après la seconde fenêtre. Les routes concernées peuvent renvoyer notamment `404 match_not_found`, `409 continuation_not_available_yet`, `409 invalid_match_state`, `409 messaging_not_available`, `410 match_expired` et `403 continuation_quota_reached`.

## Découverte

| Méthode | Route | Accès | Corps / paramètres | Résultat |
| --- | --- | --- | --- | --- |
| POST | `/swipes` | Authentifiée | `{ "target_user_id": "uuid", "decision": "like\|pass" }` | `201 { "decision", "matched", "match"? }`. La décision est immuable pendant sa rétention. Deux likes réciproques créent atomiquement le match PostgreSQL. Limite dédiée : 120/min/utilisateur par défaut. |
| GET | `/feed` | Authentifiée | `limit` de 1 à 100 (20 par défaut), `cursor` opaque optionnel | `200 { "profiles": [...], "next_cursor": "…\|null" }`. Limite : 60/min/utilisateur, puis `429 feed_rate_limit_exceeded`. Chaque profil expose `user_id`, prénom, âge, sexe, bio éventuelle, distance arrondie au dixième et traits. |

Le demandeur et les candidats doivent posséder un compte actif, un profil avec sexe, des préférences, les
versions courantes des consentements sensible et de localisation, ainsi qu’une position fraîche de moins d’une
heure. Le feed applique dans les deux sens les tranches d’âge, le sexe recherché et la distance maximale. Il
exclut les blocages, les matchs existants et les cibles déjà swipées. PostgreSQL calcule les candidats et la
distance ; Scylla est la source des décisions et exclusions. Le curseur keyset porte la distance exacte et
l’UUID, même si la distance publique est arrondie.

Erreurs spécifiques : `409 discovery_not_ready`, `404 discovery_candidate_not_found`,
`409 swipe_already_recorded`, `400 invalid_cursor`, `429 swipe_rate_limit_exceeded`, `429 feed_rate_limit_exceeded` et
`503 discovery_unavailable`. La route historique `/fake-match` a été supprimée : un match ne peut plus être
créé que par deux likes réciproques.

## Santé (hors préfixe `/api`)

| Méthode | Route | Résultat |
| --- | --- | --- |
| GET | `/health/live` | `200 { "status": "ok" }` si le processus répond. |
| GET | `/health/ready` | `200 { "status": "ready" }` si PostgreSQL, ScyllaDB activée et Redis requis répondent ; sinon `503`. |
