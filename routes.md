# Histae API — routes existantes

Mise à jour : 2 septembre 2026. Toutes les routes ci-dessous sont préfixées par `/api`.

## Conventions

- Ce fichier est la référence du contrat HTTP ; l’API n’expose ni document OpenAPI ni interface Swagger.
- Les requêtes avec corps utilisent JSON. Les champs non documentés sont refusés.
- Taille maximale d’un corps JSON : **1 Mio**.
- L’upload photo est la seule entrée multipart : `Idempotency-Key: <UUID v4>` et un fichier de **500 000 octets maximum** dans le champ `photo`.
- Les erreurs suivent le format `{ "error": { "code", "message" } }`.
- Une route « authentifiée » requiert `Authorization: Bearer <access_token>`. Le compte doit être non supprimé et non banni. Pour un utilisateur, les CGU et la notice de confidentialité courantes doivent aussi être enregistrées ; sinon la route renvoie `403 onboarding_incomplete`.
- Pendant l'onboarding, `GET /auth/me`, `GET|PUT /users/me/consents`, `POST /auth/logout`, `POST /users/me/deletion-token` et `DELETE /users/me` restent accessibles. Les comptes administrateur sont exemptés de l'onboarding utilisateur.
- Une route « admin » accepte les rôles `admin` et `superadmin`.
- `limit` est un entier de 1 à 100 (20 par défaut). Les listes volumineuses renvoient `next_cursor`; passez-le ensuite dans `cursor`. `offset` reste accepté pour compatibilité, mais est déprécié et doit valoir `0` avec un curseur.
- Un rate limit global par IP est actif et partagé dans Redis entre les instances de l’API. Les clés Redis sont pseudonymisées par HMAC. En cas de dépassement : `429 rate_limit_exceeded` avec l’en-tête `Retry-After` ; Redis indisponible produit `503 rate_limit_unavailable`.
- `X-Request-ID` est renvoyé dans chaque réponse. Un UUID v4 fourni par le client est conservé ; toute autre valeur est remplacée.
- Toutes les réponses désactivent le cache et portent des en-têtes défensifs contre le MIME sniffing, l’intégration en frame, les referrers et les permissions navigateur. HSTS est ajouté en production.

## Authentification

| Méthode | Route | Accès | Entrée | Résultat |
| --- | --- | --- | --- | --- |
| GET | `/auth/me` | Authentifiée, onboarding incomplet accepté | — | `200 { "user_id", "onboarding_complete" }`. Bootstrap minimal de session pour l’application mobile, sans exposer le rôle administratif. |
| POST | `/auth/otp/send` | Public | En-tête obligatoire `Idempotency-Key: <UUID v4>` et `{ "phone_number": "+336…" }`. Seuls les numéros français `+33` sont acceptés. | `202 { "message": "Verification code request accepted." }` après acceptation de la demande. Une clé absente ou mal formée renvoie `400 invalid_idempotency_key`; sa réutilisation pour un autre numéro renvoie `409 idempotency_key_conflict`. Une erreur ou une réponse Sweego invalide renvoie `503 otp_delivery_unavailable`. Limite : 5/h par IP et par numéro pseudonymisé. |
| POST | `/auth/otp/verify` | Public | `{ "phone_number": "+336…", "otp": "123456" }`, numéro français `+33` uniquement | `200` avec `{ "access_token", "refresh_token" }`. Le code OTP est consommé une seule fois. Si le téléphone n’est associé à aucun compte, un compte de rôle `user` est créé. Limite : 5/h par IP et numéro pseudonymisé. |
| POST | `/auth/refresh` | Public | `{ "refresh_token": "jti:secret" }` | `200` avec une nouvelle paire de tokens. Le token utilisé est révoqué dans la même transaction. Limite : 30/15 min/IP. |
| POST | `/auth/logout` | Authentifiée | `{ "refresh_token": "jti:secret", "device_id"?: "uuid" }` | `204`, révoque le refresh token s’il appartient à l’utilisateur courant et supprime atomiquement l’enregistrement push indiqué. |

Pour l’envoi OTP, l’API persiste d’abord un hash avec l’état `pending`, appelle l’endpoint transactionnel Sweego, puis passe le code à `sent` uniquement après une réponse HTTP `200` contenant un `transaction_id` et un identifiant `swg_uids` valides. Rejouer rapidement la même clé lorsque la demande est `pending`, ou rejouer une demande déjà `sent`, renvoie le même `202` sans second appel fournisseur. Un `pending` plus ancien que le timeout Sweego augmenté de cinq secondes est marqué `failed` lors du retry et renvoie `503`, comme toute autre demande échouée. L’activation est sérialisée par téléphone et la base garantit qu’un seul OTP envoyé reste utilisable. La durée de validité est définie par `OTP_TTL`.

Le 17 août 2026, ce contrat a été validé manuellement avec Sweego réel : envoi vers un numéro français, retry de la même clé sans second SMS, vérification du code, accès Bearer, rotation du refresh token avec refus de l’ancien et logout `204`.

Les access tokens utilisent HS256, le type `access`, l’issuer `histae-api`, l’audience `histae-app` et expirent selon `JWT_ACCESS_TTL`; les refresh tokens contiennent un secret aléatoire de 256 bits et suivent `JWT_REFRESH_TTL`. Les erreurs d’authentification les plus courantes sont `authentication_required`, `invalid_or_expired_access_token`, `invalid_or_expired_refresh_token`, `invalid_idempotency_key`, `idempotency_key_conflict`, `otp_delivery_unavailable`, `otp_rate_limit_exceeded` et `refresh_rate_limit_exceeded`.

## Plans

| Méthode | Route | Accès | Résultat |
| --- | --- | --- | --- |
| GET | `/plans` | Public | `200 { "plans": [...] }`. Chaque plan expose son code, nom, prix mensuel/annuel, devise, jours d’essai, éventuelle limite hebdomadaire et fonctionnalités. |

## Abonnement Stripe utilisateur

Le client mobile n’envoie jamais de Product ID, Price ID, montant, devise, durée d’essai ou identifiant de client Stripe. L’API choisit le Price mensuel ou annuel depuis sa configuration, et seul un webhook Stripe signé peut modifier les droits Premium. Les créations de Checkout et de portail sont limitées à 10/min/utilisateur par défaut.

| Méthode | Route | Accès | Corps / paramètres | Résultat |
| --- | --- | --- | --- | --- |
| GET | `/users/me/subscription` | Authentifiée | — | `200` avec `plan`, `provider`, `status`, `access_granted`, `billing_period`, les dates de période/essai/annulation, `cancel_at_period_end` et `customer_portal_available`. Les statuts Stripe donnant accès sont `trialing`, `active` et `past_due`, uniquement pendant la période projetée. |
| POST | `/users/me/subscription/checkout` | Authentifiée | En-tête obligatoire `Idempotency-Key: <UUID v4>` et `{ "billing_period": "monthly\|annual" }` | `201 { "session_id", "url", "expires_at" }`. URL Checkout hébergée, valable 30 minutes. Une seule session peut être créée ou ouverte par utilisateur. Un premier abonnement peut recevoir l’essai du catalogue ; un essai déjà consommé n’est jamais réattribué. |
| POST | `/users/me/subscription/portal` | Authentifiée | — | `201 { "url" }`. Crée une session courte du portail client Stripe pour gérer moyen de paiement, changement de tarif et annulation. Requiert un client Stripe déjà lié. |
| POST | `/billing/stripe/webhook` | Public, signature Stripe obligatoire | Corps JSON brut et en-tête `Stripe-Signature` | `200 { "received": true }`. Vérifie le corps brut avec `STRIPE_WEBHOOK_SECRET`, refuse un événement test/live incohérent, déduplique par Event ID et traite transactionnellement Checkout, abonnements, factures et suppression du Customer. Cette route est exclue de la petite limite globale mais limitée séparément à 300/min/IP par défaut. |

Événements traités : `checkout.session.completed`, `checkout.session.expired`, `customer.subscription.created|updated|deleted|paused|resumed|trial_will_end`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.finalization_failed` et `customer.deleted`. Les autres événements valides sont acquittés sans effet métier ni stockage. Les événements de facture ou d’abonnement plus anciens que la projection courante sont ignorés. Les transitions d’abonnement émettent `subscription.updated` en SSE ; un paiement échoué ou une fin d’essai proche produit aussi une notification persistée/FCM.

Erreurs spécifiques : `billing_unavailable`, `invalid_stripe_signature`, `stripe_mode_mismatch`, `invalid_stripe_event`, `stripe_request_failed`, `subscription_already_active`, `checkout_already_in_progress`, `idempotency_key_reused`, `idempotency_key_consumed`, `billing_customer_not_found`, `billing_rate_limit_exceeded` et `billing_webhook_rate_limit_exceeded`.

## Console d’administration

Toutes ces routes exigent un compte `admin` ou `superadmin`. Les consultations de données personnelles et les actions de sûreté sont inscrites dans `data_access_log`. Les numéros de téléphone, leurs empreintes et les coordonnées précises ne sont jamais exposés au dashboard.

| Méthode | Route | Corps / paramètres | Résultat |
| --- | --- | --- | --- |
| GET | `/admin/me` | — | `200 { "user_id", "role" }`. Sert à vérifier le rôle après l’authentification OTP. |
| GET | `/admin/metrics` | `revenue_period` optionnel, mêmes valeurs que `/admin/revenue` (défaut : `month_to_date`) | Synthèse initiale des comptes, files de modération, matchs, messages, abonnements et états `user_photo`, avec le CA estimé de la période initiale. Les métriques photo incluent les quatre états, les traitements bloqués depuis 30 minutes, les dead letters et les suppressions sans événement actif. Aucun indicateur ne contient de donnée personnelle. |
| GET | `/admin/revenue` | `revenue_period=last_7_days\|last_30_days\|month_to_date\|previous_month\|year_to_date\|all_time` (défaut : `month_to_date`) | Recalcule uniquement le CA estimé : nombre d’abonnements Premium mis à jour sur la période × tarif mensuel Premium courant. Cette estimation n’est ni un registre d’encaissements ni un bénéfice comptable. |
| GET | `/admin/photo-reconciliation` | `status=all\|stale_processing\|deleting\|dead_letter` (défaut : `all`) ; `limit`, `cursor` (`offset` déprécié) | File paginée des traitements photo anciens et suppressions en cours. Retourne les UUID photo/utilisateur, états, métadonnées techniques, diagnostic et état outbox, mais jamais `object_key`, URL signée ou image. |
| POST | `/admin/photo-reconciliation/:id/retry` | UUID photo ; `{ "reason": "…" }` obligatoire (3 à 500 caractères) | `202` après remise en file transactionnelle. Une photo `ready` ou un traitement récent renvoie `409 photo_reconciliation_not_allowed`; un événement possédé par un worker actif renvoie `409 photo_reconciliation_in_progress`; une photo absente renvoie `404 photo_not_found`. La photo passe à `deleting`, l’événement `photo.delete` est créé ou réinitialisé et l’action `admin_reconcile_photo` est auditée dans la même transaction. |
| GET | `/admin/users` | `status=active\|banned`, `role=user\|admin\|superadmin`, `search` optionnels ; `limit`, `cursor` (`offset` déprécié) | `200 { "users": [...], "next_cursor" }`. La recherche porte sur le prénom ou un UUID exact. Aucun téléphone n’est retourné et `photo` vaut toujours `null` dans cette collection. |
| GET | `/admin/users/:id` | UUID ; `reason` obligatoire (3 à 500 caractères) | Détail administratif : compte, profil, préférences, traits, dernier état de consentement et fraîcheur de présence sans coordonnées. L’accès est journalisé avant qu’une éventuelle URL photo signée soit produite. |
| PATCH | `/admin/users/:id/status` | `{ "is_banned", "reason"?: "…" }`. Le motif est obligatoire pour bannir. | Bannit ou débannit le compte. Un bannissement révoque immédiatement tous ses refresh tokens. Un admin ne peut agir que sur un rôle `user`; un superadmin ne peut agir ni sur lui-même ni sur un autre superadmin. |
| GET | `/admin/matches/:id/messages` | UUID ; `reason` obligatoire ; `limit`, `cursor` (`offset` déprécié) | Conversation paginée pour modération. L’accès est journalisé pour les deux participants. |

Les administrateurs s’authentifient par les mêmes routes OTP que les autres comptes. Le dashboard vérifie ensuite le rôle avec `/admin/me` et refuse toute session qui n’est pas administrative.

## Compte utilisateur

Toutes ces routes sont authentifiées.

| Méthode | Route | Corps / paramètres | Résultat |
| --- | --- | --- | --- |
| GET | `/users/me` | — | `200` avec `user_id`, `firstname`, `birthdate`, `profile_answers` et, lorsqu’ils existent, `sex`, `bio`, `photo`. `profile_answers` contient au plus trois objets ordonnés `{ question_id, code, question, answer, position }`. `photo` est absente ou contient une URL privée signée valable cinq minutes. Retourne `404 profile_not_found` tant que le profil n’est pas complété. |
| PATCH | `/users/me/profile` | `{ "firstname", "birthdate", "sex"?: "male\|female\|other\|null", "bio"?: "…\|null" }` | `200 { "message": "profile updated" }`. `firstname` (100 octets max) et `birthdate` au format calendrier strict `YYYY-MM-DD` sont requis ; l’utilisateur doit avoir au moins 18 ans. Bio : 2 000 octets max. La photo n’est pas acceptée par cette route. |
| PUT | `/users/me/photo` | En-tête obligatoire `Idempotency-Key: <UUID v4>` et `multipart/form-data`, un fichier dans `photo` | `200 { "message": "photo updated", "photo": "https://…" }`. Extensions admises : `.jpg`, `.jpeg`, `.png`, `.heic`, `.heif`, `.webp`. Extension, MIME et signature doivent correspondre. Entrée et WebP final : 500 000 octets maximum ; une seule image, 40 Mpx au plus, ramenée au plus à 2 048 px et enregistrée sans métadonnées sous une clé versionnée. Pendant 24 h, rejouer la même clé avec le même fichier renvoie une nouvelle URL signée de la même photo sans reconversion. Une clé réutilisée avec un autre nom, MIME ou contenu renvoie `409 idempotency_key_conflict`; une clé dont la photo a depuis été remplacée ou supprimée renvoie `409 idempotency_key_consumed`; une demande encore active renvoie `409 photo_update_in_progress`. Une clé absente ou invalide renvoie `400 invalid_idempotency_key`. Limite dédiée : 10 tentatives/h/utilisateur par défaut. |
| DELETE | `/users/me/photo` | — | `204` dès que la transition est durable. La photo `ready` passe atomiquement à `deleting`, devient immédiatement invisible et un événement `photo.delete` est ajouté à l’outbox PostgreSQL. Le worker supprime ensuite l’objet privé et la ligne technique avec reprises bornées ; une panne S3 après le `204` n’annule donc pas la demande. |
| GET | `/users/me/preferences` | — | `200` avec `min_age`, `max_age`, `max_distance_km`, `looking_for`; ou `404 preferences_not_found`. |
| PATCH | `/users/me/preferences` | `{ "min_age", "max_age", "max_distance_km", "looking_for" }` | `200 { "message": "preferences updated" }`. Âges entiers 18–99, distance entière 1–500, et `looking_for` vaut `male`, `female`, `both` ou `other`. |
| PATCH | `/users/me/presence` | `{ "latitude", "longitude" }` | `200 { "message": "presence updated" }`. Latitude : -90 à 90 ; longitude : -180 à 180. |
| POST | `/users/me/deletion-token` | — | `201 { "confirmation_token", "expires_at" }`. Remplace tout jeton précédent par un secret dédié, hashé en base, à usage unique et valable 10 minutes par défaut (`ACCOUNT_DELETION_TOKEN_TTL`, 1 à 30 min). |
| DELETE | `/users/me` | `{ "confirmation_token": "uuid:secret" }` | `204`. Consomme d’abord le jeton dédié, supprime le Customer Stripe et la photo privée, puis efface profil, réponses aux questions, préférences, traits, localisation, sessions, appareils, notifications, blocages, projection d’abonnement et swipes Scylla entrants/sortants ; les factures sont détachées du compte pour leur conservation comptable. Jeton invalide ou expiré : `401 invalid_or_expired_deletion_token`. Si un stockage externe indispensable ne permet pas un effacement complet : `503 data_erasure_unavailable`. |
| GET | `/users/me/continuation-quota` | — | `200` avec le plan effectif, l’usage et, pour un plan limité, `weekly_limit` et `remaining`. |

### Appareils, push et temps réel

| Méthode | Route | Corps / paramètres | Résultat |
| --- | --- | --- | --- |
| GET | `/users/me/devices` | — | `200 { "devices": [...] }`. Expose les UUID, plateformes, versions d’application et dates d’usage, jamais les jetons FCM. |
| POST | `/users/me/devices` | `{ "push_token", "platform": "ios\|android", "app_version"?: "…" }` | `201` avec l’appareil public. Un jeton fournisseur déjà connu est réaffecté et rafraîchi de manière idempotente. |
| DELETE | `/users/me/devices/:id` | UUID appareil | `204`, ou `404 device_not_found`. La propriété par l’utilisateur authentifié est imposée. |
| GET | `/users/me/events` | — | Flux SSE `text/event-stream` authentifié. Envoie `connected`, un heartbeat toutes les 25 secondes, puis les événements `match.created`, `match.updated`, `matches.invalidated`, `message.created`, `message.read` et `subscription.updated`. |

Le temps réel est relayé entre instances via Redis en production et fonctionne localement en mémoire lorsque Redis est explicitement désactivé. Les notifications push FCM sont optionnelles (`PUSH_PROVIDER=fcm`) et ne contiennent jamais le texte d’un message : seulement des identifiants nécessaires à la resynchronisation. Un jeton signalé `UNREGISTERED` par FCM est supprimé automatiquement.

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
| GET | `/users/me/data-export` | Authentifiée, onboarding incomplet accepté | — | `200` avec les données PostgreSQL, dont les réponses aux questions de profil, la projection d’abonnement, les factures Stripe rattachées et uniquement les décisions de swipe prises par l’utilisateur. Limite : 5/h/utilisateur, puis `429 data_export_rate_limit_exceeded`. L’export est journalisé. Si l’une des sources nécessaires est indisponible : `503 data_export_unavailable`. |
| GET | `/users/me/blocks` | Authentifiée | — | `200 { "blocks": [...] }`. `photo` vaut toujours `null` : bloquer un compte n’accorde aucun accès à sa photo privée. |
| POST | `/users/me/blocks/:userId` | Authentifiée | UUID utilisateur | `204`. Clôt immédiatement les matchs entre les deux comptes et empêche leur recréation. |
| DELETE | `/users/me/blocks/:userId` | Authentifiée | UUID utilisateur | `204`. |
| GET | `/admin/data-subject-requests` | Admin | `status` optionnel | Liste de traitement, 500 résultats maximum. |
| PATCH | `/admin/data-subject-requests/:id` | Admin | `{ "status": "in_progress\|completed\|rejected", "notes"?: "…" }` | Applique une transition contrôlée et journalisée. Terminer une demande d’effacement déclenche l’anonymisation complète. |
| GET | `/admin/data-access-logs` | Admin | `user_id` | `200 { "logs": [...] }`, 500 résultats maximum. |

## Traits

| Méthode | Route | Accès | Corps / paramètres | Résultat |
| --- | --- | --- | --- | --- |
| GET | `/traits` | Authentifiée | — | `200 { "traits": [{ "id", "name" }] }`. |
| GET | `/users/me/traits` | Authentifiée | — | `200 { "traits": [{ "id", "name" }] }` avec uniquement les traits actuellement attribués à l’utilisateur. |
| POST | `/users/me/traits` | Authentifiée | `{ "trait_id": "uuid" }` | `204`. Trait absent : `404 trait_not_found`. L’opération est idempotente pour une attribution déjà existante. |
| DELETE | `/users/me/traits/:traitId` | Authentifiée | UUID | `204`. L’opération est idempotente si le trait n’était pas attribué. |
| POST | `/admin/traits` | Admin | `{ "name": "…" }` | `201 { "id", "name" }`. Nom non vide, 100 octets maximum ; doublon : `409 trait_already_exists`. |
| PATCH | `/admin/traits/:id` | Admin | `{ "name": "…" }` | `200 { "message": "trait updated" }`. |
| DELETE | `/admin/traits/:id` | Admin | UUID | `204`. Cette version supprime physiquement le trait. |

## Questions de profil

Le catalogue initial contient quinze questions. Chaque réponse publique a la forme
`{ "question_id", "code", "question", "answer", "position" }`. Une réponse est une ligne de texte normalisée,
de 10 à 300 caractères et 1 000 octets maximum ; les caractères de contrôle sont refusés.

| Méthode | Route | Accès | Corps / paramètres | Résultat |
| --- | --- | --- | --- | --- |
| GET | `/profile-questions` | Authentifiée | — | `200 { "questions": [...] }`, trié par `display_order` puis UUID. Chaque entrée expose `id`, `code`, `prompt`, `category` et `display_order`. |
| GET | `/users/me/profile-answers` | Authentifiée | — | `200 { "answers": [...] }`, avec au plus trois réponses dans l’ordre choisi. |
| PUT | `/users/me/profile-answers` | Authentifiée | `{ "answers": [{ "question_id": "uuid", "answer": "…" }] }` | Remplace atomiquement toutes les réponses et renvoie `200 { "answers": [...] }`. Le tableau peut être vide, contient au plus trois questions distinctes et n’accepte que des questions existantes. Profil absent : `404 profile_not_found`; question absente : `404 profile_question_not_found`. |
| GET | `/admin/profile-questions` | Admin | — | `200 { "questions": [...] }`, avec dates et `answer_count` pour avertir avant une modification ou suppression. |
| POST | `/admin/profile-questions` | Admin | `{ "prompt", "category", "display_order"?: 100 }` | `201` avec la question créée. Les catégories sont `daily_life`, `personality`, `interests`, `relationships` et `conversation`. Un libellé déjà présent, sans tenir compte de la casse, renvoie `409 profile_question_already_exists`. |
| PATCH | `/admin/profile-questions/:id` | Admin | Au moins un de `{ "prompt", "category", "display_order" }` | `200` avec la question mise à jour. La modification du libellé devient immédiatement visible avec les réponses existantes. |
| DELETE | `/admin/profile-questions/:id` | Admin | UUID | `204`. Supprime définitivement la question et toutes ses réponses utilisateur dans la même opération PostgreSQL (`ON DELETE CASCADE`). |

## Signalements

| Méthode | Route | Accès | Corps / paramètres | Résultat |
| --- | --- | --- | --- | --- |
| POST | `/reports` | Authentifiée | `{ "reported_user_id": "uuid", "match_id"?: "uuid\|null", "reason": "inappropriate_content\|fake_profile\|harassment\|spam\|other", "description"?: "…\|null" }` | `201` avec le signalement. Auto-signalement interdit ; la cible doit exister. La description est limitée à 2 000 octets. Un match fourni doit relier les deux utilisateurs. Limite : 5/h/utilisateur par défaut. |
| GET | `/admin/reports` | Admin | `status` optionnel : `pending`, `reviewed`, `dismissed`; `limit`, `cursor` (`offset` déprécié) | `200 { "reports": [...], "next_cursor": "…\|null" }`, tri antéchronologique. |
| PATCH | `/admin/reports/:id` | Admin | `{ "status": "pending\|reviewed\|dismissed" }` | `200 { "message": "report updated" }`, ou `404 report_not_found`. |

## Matchs et messagerie

| Méthode | Route | Accès | Corps / paramètres | Résultat |
| --- | --- | --- | --- | --- |
| GET | `/matches/me` | Authentifiée | `limit`, `cursor` (`offset` déprécié) | `200 { "matches": [...], "next_cursor": "…\|null" }`, triés par activité. Chaque élément contient l’autre utilisateur (`firstname`, âge, sexe, bio, traits, `profile_answers` et photo conditionnelle), `my_revealed`, `photos_revealed`, `my_continued`, `unread_count` et `last_message`. La photo reste `null` avant la révélation mutuelle. |
| GET | `/matches/:userId` | Admin | UUID utilisateur ; `reason` obligatoire (3 à 500 caractères) ; `limit`, `cursor` (`offset` déprécié) | Même réponse paginée pour l’utilisateur ciblé. La consultation est inscrite dans `data_access_log`. |
| PATCH | `/matches/:id/reveal` | Authentifiée | — | `200` avec `{ "message", "photos_revealed" }`. Chaque participant enregistre son consentement ; `photos_revealed` devient vrai quand les deux ont consenti. |
| PATCH | `/matches/:id/continue` | Authentifiée | — | `200` avec `{ "message", "match_confirmed" }`. Disponible après la fenêtre initiale de 24 h, puis demande le consentement des deux participants. Le quota hebdomadaire est débité lorsque le second consentement confirme le match. |
| GET | `/matches/:id/messages` | Authentifiée | UUID match ; `limit`, `cursor` (`offset` déprécié) | `200 { "messages": [...], "next_cursor": "…\|null" }`. Le demandeur doit participer au match. |
| POST | `/matches/:id/messages` | Authentifiée | En-tête obligatoire `Idempotency-Key: <UUID v4>` et `{ "content": "…" }` | `201` avec le message stable. Rejouer la même clé, le même match et le même contenu retourne le message existant sans nouvelle notification ; réutiliser la clé pour une autre requête renvoie `409 idempotency_key_conflict`. Contenu non vide, 2 000 caractères maximum. Limite : 60/min/utilisateur. |
| PATCH | `/matches/:id/messages/read` | Authentifiée | `{ "read_through_message_id": "uuid" }` | `200 { "updated_count", "read_through_message_id" }`. Marque en une transaction tous les messages reçus jusqu’à la borne incluse. |
| PATCH | `/matches/:id/messages/:msgId/read` | Authentifiée | UUID match et UUID message | `200 { "message": "message marked as read" }`. Un expéditeur ne peut pas marquer son propre message comme lu. |

Un match est initialement `active` pendant 24 h. Il passe ensuite à `awaiting_continuation`, puis à `confirmed` si les deux utilisateurs acceptent, ou à `expired` après la seconde fenêtre. Les routes concernées peuvent renvoyer notamment `404 match_not_found`, `409 continuation_not_available_yet`, `409 invalid_match_state`, `409 messaging_not_available`, `410 match_expired` et `403 continuation_quota_reached`.

## Découverte

| Méthode | Route | Accès | Corps / paramètres | Résultat |
| --- | --- | --- | --- | --- |
| GET | `/users/me/discovery-status` | Authentifiée | — | `200 { "ready", "required_actions", "presence_expires_at" }`. Les actions possibles sont `profile`, `sex`, `preferences`, `sensitive_data_consent`, `location_consent` et `fresh_presence`. |
| POST | `/swipes` | Authentifiée | `{ "target_user_id": "uuid", "decision": "like\|pass" }` | `201 { "decision", "matched", "match"? }`. La décision est immuable pendant sa rétention. Deux likes réciproques créent atomiquement le match PostgreSQL. Limite dédiée : 120/min/utilisateur par défaut. |
| GET | `/feed` | Authentifiée | `limit` de 1 à 100 (20 par défaut), `cursor` opaque optionnel | `200 { "profiles": [...], "next_cursor": "…\|null" }`. Limite : 60/min/utilisateur, puis `429 feed_rate_limit_exceeded`. Chaque profil expose `user_id`, prénom, âge, sexe, bio éventuelle, distance arrondie au dixième, traits et `profile_answers`. |

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
| GET | `/health/ready` | `200 { "status": "ready" }` si PostgreSQL, le bucket objet, ScyllaDB activée et Redis requis répondent ; sinon `503`. |

Les erreurs photo spécifiques sont `400 invalid_idempotency_key`, `400 invalid_photo`, `413 photo_too_large`,
`404 profile_not_found`, `409 idempotency_key_conflict`, `409 idempotency_key_consumed`,
`409 photo_update_in_progress`, `409 photo_update_conflict`, `429 photo_rate_limit_exceeded` et
`503 photo_storage_unavailable`.
