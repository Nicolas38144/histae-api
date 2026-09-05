# Politique de journalisation

Cette politique s’applique à l’API, aux workers et aux scripts d’exploitation. Les logs servent à détecter et
relier un incident technique ; ils ne constituent ni une base métier, ni un journal de contenu, ni une source
d’audit administrateur. Les audits réglementaires et de modération restent dans PostgreSQL avec leur propre rétention.

## Format et données autorisées

Les événements applicatifs utilisent un code stable en `snake_case`, suivi uniquement de champs `clé=valeur`
validés par `common/logging/safe-logging.ts`. Une erreur externe ou inattendue devient un `error_code` borné ;
son message, sa stack et sa cause ne sont jamais journalisés.

Champs admis lorsqu’ils sont nécessaires : méthode HTTP, modèle de route, statut, durée, `request_id`, compteurs,
environnement, type d’événement outbox et UUID technique de cet événement. Les logs HTTP emploient par exemple
`/api/admin/users/:userId`, jamais le chemin concret ni sa query string.

Sont interdits, y compris en développement :

- téléphone, nom, bio, réponse libre ou contenu de message ;
- JWT, refresh token, OTP, passkey, cookie, en-tête d’autorisation ou secret fournisseur ;
- token FCM, clé objet, URL signée ou corps photo ;
- payload/réponse Sweego, Stripe, FCM, S3, Redis, Scylla ou PostgreSQL ;
- motif administratif, contenu de modération, corps ou query string HTTP ;
- message, stack, cause ou sérialisation brute d’une exception.

Les erreurs des commandes passent par `scripts/cli-output.ts`. L’unique exception volontaire est la commande
d’enrôlement WebAuthn : elle affiche une seule fois son jeton sur stdout parce que cette sortie est le résultat
de la commande. L’exécuter dans un terminal privé, sans redirection ni capture durable.

## Niveaux

| Niveau | Usage |
| --- | --- |
| `log` | Démarrage réussi ou fin explicite d’une commande, sans donnée métier. |
| `warn` | Échec récupérable, entrée ignorée, dépendance temporaire ou traitement à reprendre. |
| `error` | Échec inattendu, réponse HTTP 5xx, dead letter ou impossibilité de poursuivre un processus. |

Histae n’émet actuellement aucun détail `debug` ou `verbose`. Une investigation plus fine doit utiliser des
métriques agrégées, les statuts persistants et une reproduction contrôlée, pas réactiver les données interdites.

## Destination, rétention et accès

L’application écrit uniquement sur stdout/stderr ; elle ne crée aucun fichier de log et ne dépend d’aucun
fournisseur de collecte. Un runtime Docker ou un futur collecteur doit conserver le même filtrage.

| Environnement | Destination | Conservation maximale | Accès |
| --- | --- | --- | --- |
| Développement | Terminal local ou logs du conteneur local | Durée de la session ; 7 jours au maximum si une rotation locale les conserve | Développeur de la machine |
| Test | Sortie du processus de test | Durée du test ; résultat d’échec 7 jours au maximum s’il est conservé | Développeurs autorisés |
| Production | stdout/stderr collectés par l’infrastructure retenue | 30 jours glissants, sauf gel d’incident approuvé et daté | Exploitation d’astreinte et sécurité, au moindre privilège |

Le collecteur de production devra chiffrer le transport et le stockage, imposer l’authentification, tracer les
accès, appliquer la suppression automatique et éviter toute réplication vers un outil non approuvé. Support,
modération et administrateurs métier n’obtiennent pas cet accès par défaut. La durée de 30 jours reste soumise à
la validation juridique de la [politique de conservation](retention-policy.md).

## Validation et incident

`logging-policy.spec.ts` interdit les sorties d’erreur directes, l’accès aux stacks et les appels `Logger` non
normalisés. `safe-logging.spec.ts` vérifie que messages, causes, URLs signées, téléphones et secrets ne passent pas
le formateur. Les contrats HTTP vérifient séparément l’absence de fuite dans les réponses.

Lors d’un incident, corréler `request_id`, métriques, état de maintenance et dead letters. Ne jamais demander à un
utilisateur d’envoyer un token ou copier un payload réel dans un ticket. Si le code normalisé ne suffit pas,
reproduire avec des données synthétiques dans un environnement isolé.
