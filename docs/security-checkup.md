# Check-up de sécurité — 2 septembre 2026

## Portée et niveau de confiance

Ce contrôle porte sur le code de l’API, sa configuration, les schémas PostgreSQL/ScyllaDB, les contrats HTTP,
le stockage photo et les dépendances. Il combine revue statique, tests automatisés, vérification de
configuration et audits pnpm complets/de production. Il ne remplace ni un pentest externe, ni une revue de l’infrastructure de
production, ni une analyse juridique.

## Résultat synthétique

Aucune vulnérabilité critique connue n’a été trouvée dans les dépendances de production et aucune injection SQL
évidente n’a été identifiée : les valeurs issues des requêtes HTTP sont liées par paramètres. Les contrôles
d’authentification, d’autorisation, d’idempotence et de confidentialité sont globalement solides. Les problèmes
directement corrigeables trouvés pendant la revue ont été traités.

| Zone | État | Contrôles principaux |
| --- | --- | --- |
| Authentification | Satisfaisant | JWT HS256 avec issuer/audience/type, secrets de refresh 256 bits hashés, rotation transactionnelle, OTP HMAC et usage unique. |
| Autorisation | Satisfaisant | Rôle et état actif relus depuis PostgreSQL, guards admin, onboarding et consentements imposés côté serveur. |
| Entrées | Satisfaisant | DTO stricts, whitelist avec rejet des champs inconnus, limites métier, UUID et dates validés. |
| SQL/CQL | Satisfaisant | Paramètres liés côté PostgreSQL ; identifiants Scylla issus uniquement de configuration validée. |
| Limites de débit | Satisfaisant | Redis obligatoire en production, clés HMAC, échec fermé, `Retry-After`, limite globale et limites sensibles dédiées. |
| Photos | Satisfaisant | Bucket privé, formats/MIME/signature/dimensions vérifiés, 500 000 octets entrée et sortie, WebP sans métadonnées, upload idempotent 24 h, clés versionnées, suppression par outbox durable et URL courte signée seulement au besoin. |
| Questions de profil | Satisfaisant avec modération à compléter | Trois réponses au plus, questions distinctes, texte normalisé et borné, SQL paramétré, remplacement transactionnel et suppression en cascade annoncée dans le dashboard. |
| Données sensibles | Satisfaisant avec dépendances infra | Téléphone HMAC + AES-256-GCM, logs HTTP sans query string, export/effacement inter-bases et politique de rétention. |
| Dépendances | Satisfaisant au contrôle | Audits pnpm complet et production : aucune vulnérabilité connue le 1er septembre 2026. |

## Corrections appliquées pendant le contrôle

- Le hook global de rate limiting renvoie maintenant explicitement la réponse `429`, ce qui interdit la poursuite
  accidentelle du handler Fastify après le rejet.
- Les en-têtes `Cache-Control: no-store`, CSP restrictive, `Permissions-Policy`, `Referrer-Policy`,
  `X-Content-Type-Options`, `X-Frame-Options` et HSTS en production sont centralisés pour toutes les réponses.
- Un `X-Request-ID` client n’est accepté que s’il s’agit d’un UUID v4 ; sinon l’API en génère un.
- `TRUST_PROXY=true` est interdit en production. Il faut fournir les adresses IP ou CIDR exacts des proxies,
  afin qu’un client ne puisse pas usurper son IP et contourner les limites de débit.
- OpenAPI, Swagger, leurs routes et leur dépendance applicative ont été retirés de tous les environnements.
- La liste admin des comptes et la liste des comptes bloqués ne génèrent plus de liens signés vers les photos.
  Le détail admin conserve le motif obligatoire et l’audit avant de produire une éventuelle URL.
- Le parseur des refresh tokens impose désormais un UUID v4 canonique et exactement 43 caractères base64url.
- Les appels S3 réseau sont annulés après 10 secondes. Le fallback mémoire du rate limiter purge périodiquement
  ses entrées expirées.
- La table `user_photo` ne rend visible que l’état `ready`, impose la cohérence des métadonnées WebP et conserve
  les états `processing`/`deleting` après une issue S3 incertaine. La maintenance effectue des suppressions
  idempotentes et évite ainsi l’écrasement ou l’oubli silencieux d’un objet lors d’un remplacement.
- L’upload photo exige une clé UUID v4. PostgreSQL sérialise les mutations par profil et conserve seulement un
  SHA-256 de la requête pendant 24 heures : un replay identique ne redécode pas l’image, une clé réutilisée avec
  un autre contenu est refusée et une ancienne réponse devenue obsolète ne peut pas redevenir visible.
- Le remplacement ou la suppression d’une photo écrit `photo.delete` dans la même transaction que le passage à
  `deleting`. Le worker outbox utilise `SKIP LOCKED`, des lots et une concurrence bornés, un backoff exponentiel,
  dix tentatives et une dead-letter. Seuls des codes d’erreur normalisés sont persistés, sans détail fournisseur.
- La console admin ne reçoit ni clé objet, ni URL, ni image dans la file `user_photo`. Une relance refuse les photos
  `ready`, les traitements récents et les workers actifs, puis remet la suppression en file et inscrit le motif sous
  `admin_reconcile_photo` dans la même transaction.
- Les questions de profil utilisent des catégories fermées, des libellés uniques et des bornes applicatives et SQL.
  Le remplacement des réponses verrouille le profil et les questions concernées ; une suppression administrative
  efface la question et ses réponses par cascade atomique, après affichage du nombre d’enregistrements concernés.
- Les commentaires SQL décrivent maintenant correctement le HMAC-SHA-256 et l’AES-256-GCM applicatifs.

## Risques résiduels et actions avant production

1. **Authentification administrative** : les administrateurs utilisent encore le même OTP SMS que les utilisateurs.
   Mettre en place une authentification forte distincte (SSO/MFA résistante au phishing), une politique de session
   admin plus courte et des alertes sur les accès sensibles.
2. **Protection périmétrique** : placer l’API derrière un reverse proxy/WAF avec TLS, limites de connexion et de
   taille, protection DDoS et liste explicite des proxies de confiance. Tester la vraie chaîne d’adresses client.
3. **Secrets et clés** : utiliser un gestionnaire de secrets, définir une rotation, tester la révocation et séparer
   les clés par environnement. Les sauvegardes et volumes doivent être chiffrés par l’infrastructure.
4. **Stockages de production** : choisir une cible S3 compatible durable, privée, versionnée ou sauvegardée,
   supervisée et testée en restauration. Déployer PostgreSQL, Redis et ScyllaDB avec TLS, authentification,
   redondance et sauvegardes vérifiées.
5. **Observabilité** : les états `user_photo`, traitements bloqués, suppressions sans événement actif et dead letters
   sont désormais agrégés pour le dashboard. Ajouter la collecte et les alertes sur les `401/403/429/5xx`, les
   échecs OTP/Stripe/S3, les accès administratifs, la saturation des pools et les retards de maintenance, sans
   journaliser de données sensibles.
6. **Validation offensive** : faire réaliser un pentest authentifié couvrant IDOR/BOLA, élévation de privilèges,
   concurrence, abuse cases OTP, webhooks Stripe, multipart/HEIC et URLs signées. Ajouter SAST, secret scanning et
   audit de dépendances récurrent dans la chaîne de livraison lorsque celle-ci sera définie.
7. **Contenu de profil** : ajouter la détection qualité/modération prévue pour les bios, photos et réponses libres,
   avec un parcours de signalement et de revue adapté avant une ouverture publique à grande échelle.

## Hypothèses importantes

- L’API utilise des Bearer tokens dans l’en-tête `Authorization`, pas une session cookie ; le risque CSRF classique
  n’est donc pas le mécanisme principal. CORS reste limité aux origines explicitement configurées.
- HSTS n’est utile que si le frontal sert réellement l’API en HTTPS et ne doit pas être interprété comme une
  terminaison TLS fournie par Node.
- La compatibilité S3 du code ne garantit pas la sécurité du bucket : politique privée, comptes techniques,
  rotation, sauvegarde et réseau sont des responsabilités du déploiement.

## Validation exécutée

- `pnpm audit --audit-level low` et sa variante `--prod` : aucune vulnérabilité connue ;
- `pnpm run lint`, `pnpm run typecheck` et `pnpm run build` : réussis ;
- tests unitaires : 41 suites, 257 cas réussis ;
- tests e2e Fastify : 10 suites, 62 cas réussis ;
- intégrations PostgreSQL, ScyllaDB et Redis : 3 suites, 44 cas réussis ;
- migrations PostgreSQL : `005_profile_questions` appliquée puis vérifiée idempotente sur `histae-dev`; baseline et migrations incrémentales appliquées avec succès dans un schéma temporaire vide et intégralement annulées.
- état Docker local : SeaweedFS, Redis et ScyllaDB déclarés `healthy`; configuration Compose objet valide.
