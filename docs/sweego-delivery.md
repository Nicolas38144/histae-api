# Suivi des OTP Sweego

Contrat vérifié le 4 septembre 2026. Aucun nouveau composant ni dépendance : PostgreSQL, Sweego et les
métriques administratives existantes suffisent. Ce suivi ne constitue pas une garantie de réception au téléphone.

## Contrat fournisseur et limites

La [référence d’envoi](https://learn.sweego.io/docs/sweego/send-send-post) décrit un POST asynchrone :
le HTTP 200 fournit `transaction_id` et `swg_uids`. `campaign-id` est un identifiant de campagne personnalisé,
pas une garantie d’idempotence. Histae y transmet l’UUID de sa tentative, jamais le téléphone ou le code.
Aucune garantie documentée de déduplication des POST n’a été trouvée : aucun retry réseau automatique.

Les [événements SMS](https://learn.sweego.io/docs/webhooks/sms_events) et leurs
[payloads](https://learn.sweego.io/docs/webhooks/sms_payload) exposent notamment `sms_sent` et `sms_undelivered`.
La documentation consultée ne définit pas `sms_sent` comme une preuve de réception au terminal. Histae garde
donc explicitement cette réception **non confirmée**, sans fabriquer d’événement `sms_delivered`.
Les timestamps des exemples ne portent pas toujours de fuseau : ils ne servent ni à ordonner les décisions ni
à calculer une latence opérateur. Les délais exposés utilisent l’horloge PostgreSQL à réception locale.

La [signature officielle](https://learn.sweego.io/docs/webhooks/webhook_signature) est un HMAC-SHA256 de
`webhook-id.webhook-timestamp.corps-brut`, encodé en base64. Le secret de 64 caractères fourni par Sweego doit
être **décodé en base64**, pas utilisé comme texte brut. La comparaison Histae est à temps constant.

## Configuration locale et déploiement

1. Arrêter les anciens écrivains OTP, exécuter `pnpm run db:migrate`, puis relancer API/workers compatibles.
   Le schéma final est intégré à `001_baseline_20260904`. Une base antérieure à 014 doit d’abord appliquer cette
   ancienne migration avec la version précédente : elle convertissait `sent` (acceptation HTTP) en `accepted`.
   Voir [la transition sans reset](postgres-migrations.md). Ne pas redémarrer les anciens écrivains pré-014.
2. Conserver les paramètres d’envoi existants. Renseigner `SWEEGO_WEBHOOK_SECRET` avec le secret de la destination
   Sweego ; ce n’est **pas** `SWEEGO_API_KEY`. Une valeur vide désactive les callbacks (503), sans désactiver l’envoi.
3. Configurer dans Sweego une destination vers `POST /api/auth/sweego/webhook`, abonnée à `sms_sent` et
   `sms_undelivered`, avec le Sender ID configuré dans l’API. Aucun compte/session admin n’est transmis.
4. `localhost` n’est pas joignable par Sweego : pour un essai réel, il faut une URL HTTPS joignable qui route vers
   cette API. Le mécanisme de transport reste libre ; aucune dépendance Cloudflare n’est introduite.
   Ne jamais envoyer de vrais OTP à un collecteur public de test. Les suites locales utilisent des signatures synthétiques.
5. Avant production, activer la destination, vérifier un SMS de test autorisé et son callback signé, ainsi que
   le comportement réel des retries Sweego. Les tests locaux ne valident ni l’opérateur mobile ni les paramètres du compte Sweego.

La limite dédiée `RATE_LIMIT_SMS_WEBHOOK=300` / `RATE_LIMIT_SMS_WEBHOOK_WINDOW=1m` remplace la limite globale
sur cette route. Les requêtes restent refusées si la protection Redis requise est indisponible.
Le corps signé est borné à 16 Kio, à l’intérieur du plafond HTTP global de 1 Mio.

La fenêtre anti-rejeu est de cinq minutes, avec une minute de tolérance d’horloge future. Un événement métier
ancien peut être traité tant que son **envoi webhook** est fraîchement signé. Un rejeu d’une ancienne requête
signée hors fenêtre est refusé. La politique exacte de re-signature et de retry de Sweego reste à éprouver sur
le compte utilisé ; ne pas retirer le contrôle temporel pour masquer une incompatibilité.

## États et conduite de reprise

| État interne | Signification | OTP utilisable ? |
| --- | --- | --- |
| `pending` | Intention persistée, appel en cours ; passé le timeout + 5 s, l’issue est considérée `unknown`. | Non. |
| `accepted` | Réponse HTTP 200 exploitable, ou ancienne acceptation migrée. | Oui, s’il est courant, non consommé et non expiré. |
| `sent` | Callback `sms_sent` authentifié et corrélé. | Même règle ; ne prouve pas une réception au téléphone. |
| `unknown` | Réseau/timeout, réponse inexploitable, HTTP incertain ou processus interrompu. | Non, en attendant une confirmation. |
| `failed` | Rejet HTTP explicite ou callback `sms_undelivered`. | Non. |

Les HTTP 400/401/403/404/405/413/415/422/429 sont traités comme rejets ; les autres non-200, dont 408 et 5xx,
restent incertains. Un corps fournisseur n’est jamais conservé dans une erreur. Une perte d’acquittement
PostgreSQL **après** l’acceptation ne transforme pas celle-ci en rejet.

Le mobile conserve la même clé et le même numéro pour rejouer une intention. Pendant la rétention de la
demande, ce replay ne provoque aucun autre POST Sweego. `202` n’est pas une preuve de livraison.
`503 otp_delivery_unknown` invite à attendre la confirmation ; `503 otp_delivery_unavailable` indique l’échec
enregistré ou une confirmation devenue inexploitable. Pour demander un nouveau code, créer une **nouvelle intention
explicite**, avec une nouvelle clé et les limites OTP habituelles. Ne pas boucler automatiquement avec de nouvelles clés.

Après une réponse perdue, un callback signé `sms_sent` peut activer le code initial. Sans callback et sans
acquittement HTTP récupérable, Histae ne peut pas savoir si le SMS a été envoyé : le code reste inutilisable.
La reprise n’envoie jamais un ancien OTP à nouveau et ne prolonge jamais sa durée de vie.

## Concurrence et confidentialité

`OtpRepository` prend le verrou transactionnel du téléphone pseudonymisé avant les lignes OTP pour
l’acceptation, les callbacks et la consommation. L’ordre des tentatives est local et monotone ; le code
courant reste utilisable lorsqu’une tentative plus récente est rejetée sans avoir été acceptée.
Une acceptation plus récente invalide les tentatives antérieures. Les callbacks tardifs ne peuvent rétablir
ces codes, même si le code plus récent a déjà été consommé. L’expiration est relue après le verrou.

Le callback doit correspondre à `campaign_id` (UUID de tentative) et à `swg_uid`, ainsi qu’à `transaction_id`
lorsqu’il est fourni et déjà connu. Une divergence retourne 409, sans mutation. Un callback peut précéder
la réponse HTTP ; celle-ci enrichit alors les références sans rétrograder l’état. `failed` est absorbant :
un `sms_sent` désordonné ne réactive pas un OTP déclaré non livré. Une telle contradiction nécessite un diagnostic,
pas un renvoi automatique. Les transitions monotones dédupliquent aussi des notifications répétées avec des Event IDs différents.

Les requêtes signées hors périmètre, simulations, autres Sender IDs/campagnes et tentatives déjà purgées sont
acquittées sans créer de ligne. Les événements pris en charge sont strictement validés ; leurs champs annexes
sont immédiatement écartés. Aucun journal de payloads ni nouvelle durée de conservation n’est ajouté.
Les métadonnées suivent la purge OTP existante à expiration, ainsi que l’effacement du compte.

## Observabilité et validation

`GET /api/admin/metrics` expose `operations.sms_delivery` :

- `states` : compteurs `pending, accepted, sent, failed, unknown` des tentatives non expirées ; les `pending`
  abandonnées sont vues comme `unknown` même sans replay mobile ;
- `awaiting_callback`, `oldest_unresolved_age_seconds` et moyennes locales d’acceptation, de callback d’envoi et
  d’échec (`average_acceptance_ms`, `average_sent_callback_ms`, `average_failure_ms`) ;
- `webhook_enabled`, `handset_delivery: not_confirmed`, `retention: otp_expiry` ;
- `callbacks` : compteurs par issue normalisée, propres au processus et remis à zéro au redémarrage.

Le compteur de dépendance `sweego` conserve la latence et les erreurs des POST ; le suivi HTTP donne celles du
webhook. Les états SMS ne sont pas un historique ni des taux sur une fenêtre fixe : ils excluent les OTP expirés,
y compris avant leur purge physique. Pour une alerte durable, collecter les agrégats régulièrement (R08).
Aucun identifiant de compte, de tentative, téléphone, OTP, clé ou payload n’est exposé. Aucun écran dashboard
supplémentaire n’est imposé ; ces données enrichissent le contrat des métriques existantes.

Les suites `sweego-webhook.service.spec.ts`, `sweego-sms.service.spec.ts`, `sweego-webhook.contract.spec.ts`
et `postgres.otp-delivery.integration.spec.ts` exercent le protocole avec réponses et signatures contrôlées.
La dernière rejoue toutes les migrations dans un schéma local isolé. Commandes et prérequis : [test.md](../test.md).
Le bilan effectivement exécuté reste dans [la roadmap, lot R04](roadmap.md).
