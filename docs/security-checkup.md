# Check-up de sécurité — 3 septembre 2026

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
| Authentification | Satisfaisant | Mobile : refresh rotatifs par famille, révocation sur rejeu authentique, JWT liés à une session relue en base et clés locales par `kid`, OTP HMAC à usage unique. Admin : WebAuthn natif avec vérification utilisateur, challenges à usage unique et sessions serveur opaques. |
| Autorisation | Satisfaisant | Rôle et état actif relus depuis PostgreSQL, JWT mobile refusé sur les routes admin, guards dédiés, onboarding et consentements imposés côté serveur. |
| Entrées | Satisfaisant | DTO stricts, whitelist avec rejet des champs inconnus, limites métier, UUID et dates validés. |
| SQL/CQL | Satisfaisant | Paramètres liés côté PostgreSQL ; identifiants Scylla issus uniquement de configuration validée. |
| Limites de débit | Satisfaisant | Redis obligatoire en production, clés HMAC, échec fermé, `Retry-After`, limite globale et limites sensibles dédiées. |
| Photos | Satisfaisant avec calibration à poursuivre | Bucket privé, formats/MIME/signature/dimensions vérifiés, 500 000 octets entrée et sortie, WebP sans métadonnées, upload idempotent 24 h, clés versionnées, suppression par outbox durable, modération séparée et URL courte signée seulement au besoin. |
| Questions de profil | Satisfaisant | Trois réponses au plus, questions distinctes, texte normalisé et borné, SQL paramétré, remplacement/modération transactionnels et suppression en cascade annoncée dans le dashboard. |
| Modération | Satisfaisant avec gouvernance à finaliser | Détection locale explicable, aucune décision automatique de rejet, masquage public fail-safe, file centrale sans contenu, détail et décision motivés/audités, concurrence optimiste et suppression outbox des photos rejetées. |
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
- L’authentification du dashboard est séparée de l’OTP mobile. Elle utilise des passkeys WebAuthn découvrables sans
  fournisseur externe, vérifie l’origine, le RP ID, la présence/vérification utilisateur, la signature et le compteur,
  et ne conserve en PostgreSQL que les clés publiques et secrets opaques hashés.
- Les sessions admin utilisent un cookie `HttpOnly; SameSite=Strict`, une expiration inactive et absolue, une
  révocation serveur et une relecture du rôle, du bannissement et de la passkey. Les mutations exigent l’origine
  exacte et les opérations sur les passkeys une authentification récente. La dernière passkey et celle de la session
  courante ne sont pas révocables. L’émission d’un jeton d’enrôlement par la commande locale est elle-même auditée.
- La liste admin des comptes et la liste des comptes bloqués ne génèrent plus de liens signés vers les photos.
  Le détail admin conserve le motif obligatoire et l’audit avant de produire une éventuelle URL.
- Le parseur des refresh tokens impose désormais un UUID v4 canonique et exactement 43 caractères base64url.
- La rotation mobile conserve une filiation et un hash jusqu'à l'expiration initiale. Le rejeu d'un ancêtre
  authentique encore valide révoque sa famille dans une transaction commitée avant le `401`. Un mauvais secret
  ne révoque rien. Rotation, logout, déconnexion globale, enregistrement push et bannissement se sérialisent
  sur le compte ; la base impose un seul token actif et un seul enfant par parent.
- Les JWT exigent une famille `sid` active et un `kid` local configuré, avec HS256, issuer, audience et expiration
  vérifiés. Une révocation bloque les requêtes suivantes et retire les appareils push liés ; les SSE se ferment
  au prochain contrôle (toutes les 25 secondes) ou à l'expiration du JWT. Aucun secret, hash, IP ou user-agent
  n'est exposé dans la liste des sessions. Les métadonnées sont exportables et effacées à l'anonymisation.
- La rotation de clés HS256 accepte un trousseau local borné, sans URL, fichier ou fournisseur choisi par le JWT.
  Le déploiement coordonné de la migration 010 et la procédure de rotation sont décrits dans
  [`mobile-sessions.md`](mobile-sessions.md). L'intégration réelle du bannissement a aussi permis de corriger
  le typage UUID de son paramètre SQL `banned_by`.
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
- Les photos, bios et réponses possèdent désormais un cas de modération indépendant. Les projections publiques ne
  lisent que les contenus `approved`; les contenus existants sont migrés en `pending/legacy_unreviewed` plutôt que
  publiés sans contrôle. Le propriétaire conserve son contenu et voit son statut et les motifs.
- L’analyse automatique n’autorise qu’une approbation : un signal texte, une qualité photo insuffisante, plusieurs
  visages, un score NSFW élevé, un timeout ou une réponse invalide conduisent à une revue humaine sans rejet automatique.
- La file admin ne contient aucun texte, objet ou lien. Le détail exige un motif audité avant signature éventuelle,
  une version optimiste protège les décisions concurrentes et la revue photo exige une checklist complète. Le rejet
  d’une photo rend l’objet invisible et écrit sa suppression dans l’outbox au sein de la transaction de revue.
- Les métriques HTTP et dépendances restent agrégées en mémoire avec une cardinalité bornée, sans identifiant
  utilisateur. PostgreSQL conserve uniquement le dernier état normalisé des maintenances afin de détecter un job
  absent, bloqué ou en retard.
- Les dead letters sont listées sans payload, agrégat ni clé objet. Relance et abandon sont verrouillés et audités
  transactionnellement après authentification récente ; une suppression photo encore référencée ne peut pas être
  abandonnée. Les passkeys peuvent être renommées et les sessions gérées individuellement sans exposer de secret.
- Les commentaires SQL décrivent maintenant correctement le HMAC-SHA-256 et l’AES-256-GCM applicatifs.

## Risques résiduels et actions avant production

1. **Récupération administrative** : WebAuthn résiste au phishing mais une perte de tous les authenticators peut
   bloquer le compte. Imposer deux passkeys dont une clé physique distincte, protéger l’accès à la commande
   d’enrôlement, documenter une récupération hors bande et alerter sur les connexions et révocations.
2. **Protection périmétrique** : placer l’API derrière un reverse proxy/WAF avec TLS, limites de connexion et de
   taille, protection DDoS et liste explicite des proxies de confiance. Tester la vraie chaîne d’adresses client.
3. **Secrets et clés** : utiliser un gestionnaire de secrets, définir une rotation, tester la révocation et séparer
   les clés par environnement. Les sauvegardes et volumes doivent être chiffrés par l’infrastructure.
4. **Stockages de production** : choisir une cible S3 compatible durable, privée, versionnée ou sauvegardée,
   supervisée et testée en restauration. Déployer PostgreSQL, Redis et ScyllaDB avec TLS, authentification,
   redondance et sauvegardes vérifiées.
5. **Observabilité** : l’API agrège désormais `401/403/429/5xx`, latences, dépendances, pool PostgreSQL, outbox et
   retards de maintenance. Il reste à raccorder ce snapshot interne au système d’alertes retenu en production et
   à définir seuils, astreinte et runbooks, sans journaliser de données sensibles.
6. **Validation offensive** : faire réaliser un pentest authentifié couvrant IDOR/BOLA, élévation de privilèges,
   concurrence, abuse cases OTP, webhooks Stripe, multipart/HEIC et URLs signées. Ajouter SAST, secret scanning et
   audit de dépendances récurrent dans la chaîne de livraison lorsque celle-ci sera définie.
7. **Modération et biais** : le détecteur Haar et le petit classifieur NSFW sont des outils de triage, pas une preuve
   de conformité ni une couverture exhaustive de la violence, de la haine ou de tout contenu interdit. Calibrer les
   seuils sur un corpus représentatif, mesurer les faux positifs/négatifs et biais, définir le SLA et les habilitations
   de revue, puis fournir une procédure de contestation. Les règles texte doivent évoluer avec une politique versionnée.
8. **Client mobile** : les refresh doivent être sérialisés et les deux tokens remplacés atomiquement. Aucun délai
   de grâce n'est appliqué : une réponse perdue ou deux refresh concurrents peuvent imposer une reconnexion OTP.
   Valider ce parcours sur le mobile réel ; aucune interface de gestion des sessions n'est ajoutée au client ici.

## Hypothèses importantes

- Le client mobile utilise des Bearer tokens et les routes admin un cookie. Le risque CSRF admin est réduit par
  `SameSite=Strict` et par le contrôle serveur de l’en-tête `Origin` exact sur chaque mutation. Le dashboard et
  l’API doivent rester servis sous une même origine (`/api`) ; `http://localhost:5173` est l’exception de développement.
- HSTS n’est utile que si le frontal sert réellement l’API en HTTPS et ne doit pas être interprété comme une
  terminaison TLS fournie par Node.
- La compatibilité S3 du code ne garantit pas la sécurité du bucket : politique privée, comptes techniques,
  rotation, sauvegarde et réseau sont des responsabilités du déploiement.

## Validation exécutée

- Audit de dépendances du 1er septembre : `pnpm audit --audit-level low` et sa variante `--prod`, aucune
  vulnérabilité connue à cette date. Non relancé pour les sessions mobiles ; aucune dépendance ajoutée ou modifiée.
- `pnpm run lint`, `pnpm run typecheck` et `pnpm run build` : réussis ;
- tests unitaires : 56 suites, 346 cas réussis ;
- tests e2e Fastify : 13 suites, 82 cas réussis ;
- `pnpm test` : 69 suites et 428 cas autonomes réussis ;
- intégrations PostgreSQL, ScyllaDB et Redis : 4 suites, 66 cas réussis après redémarrage des conteneurs locaux ;
- migrations PostgreSQL : chaîne jusqu'à `010_mobile_refresh_sessions` vérifiée dans un schéma temporaire,
  y compris des anciens tokens actifs/révoqués ; 010 appliquée sans reset sur `histae-dev` et deuxième migration idempotente ;
- validation photo antérieure : analyse WebP authentifiée et smoke test S3-compatible réussis ; non rejoués
  dans cette évolution des sessions mobiles.
