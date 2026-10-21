# computer

## Périmètre de lecture

Le clone local du workspace attendu pour ce projet (`projects/agentik-studio/projects/computer`) n'est pas présent dans le conteneur d'exécution: `/home/user/workspace` est vide, et le dépôt `agentiknet/agentik-studio` refuse le clone (403 sur un dépôt privé, jeton PAT sans droit). Aucun fichier du projet n'a donc été lu.

Aucun miroir public du projet n'existe non plus: la recherche GitHub sur `computer` lié à agentproto ou agentproto ne renvoie que `agentproto/bureau` et `agentproto/ts`. Ce qui suit est reconstruit à partir de ce qui est réellement lisible et vérifiable:

- le contrat public `@agentproto/computer-api` et le provider `@agentproto/sandbox-computer`, dont le code est dans ce dépôt (`packages/computer-api`, `packages/sandbox-computer`);
- la spécification AIP-36 v1.3 (profil sandbox), lue dans le dépôt de spécifications `agentproto/agentproto`;
- le registre npm pour versions, dates de publication et téléchargements;
- les commits du dépôt plateforme qui font vivre cette brique.

Aucun build, aucune installation, aucun microVM n'ont été démarrés.

## À quoi il sert

`computer` est la brique d'exécution isolée du studio: une flotte de microVM auto-hébergée, pilotée par une API de contrôleur HTTP, qui donne à chaque agent sa propre machine plutôt qu'un conteneur partagé.

La lecture la plus cohérente vient du contrat lui-même, `@agentproto/computer-api`, décrit comme "Versioned public contract for the computer controller's HTTP API". Le modèle est celui d'un contrôleur qui crée des "computers" et les recycle:

| Endpoint | Effet |
| --- | --- |
| `POST /v1/computers` | crée une machine (modèle, CPU, mémoire, disque, TTL, egress, `maxSessions`) |
| `GET /v1/computers/:id` | état, ports publiés, métadonnées d'egress |
| `POST /v1/computers/:id/exec` | exécution de commandes dans la machine |
| `POST /v1/computers/:id/suspend` | snapshot complet et arrêt (pause) |
| `POST /v1/computers/:id/resume` | restauration, éventuellement sous un nouvel identifiant |
| `POST /v1/computers/:id/attach` / `detach` | prise et libération d'un emplacement de session |
| `DELETE /v1/computers/:id` | suppression, refusée tant que des sessions sont attachées sauf `?force=true` |

Le contrat est volontairement minimal et permissif: passe-platout partout, états de machine inconnus ramenés à `unknown` au lieu de lever une erreur, identifiants de modèle ouverts, enveloppe d'erreur générique. Il est versionné par `COMPUTER_API_VERSION`, aujourd'hui `v1`.

Côté agentproto, `@agentproto/sandbox-computer` est le `SandboxProvider` qui parle à ce contrôleur. Il démarre le daemon agentproto dans la machine, l'expose en MCP, Mapping boot/exec/readFile/writeFile/expose/pause/resume/stop/probe/connect sur les endpoints ci-dessus, avec des points de rupture résolus: le mode `daemonRoute` passe par le contrôleur au lieu d'une URL de passerelle par machine, l'egress est deny-by-default (une machine sans liste d'autorisation n'a même pas de DNS), et l'IP d'egress peut être partagée, automatique, dédiée ou issue d'un pool.

Ce que le projet apporte de neuf par rapport aux autres fournisseurs de sandbox déjà présents dans la plateforme (`e2b`, `box`, `instabox`) est explicite dans AIP-36 v1.3: la machine survit à la fin de la session (pause et reprise avec snapshot), plusieurs agents peuvent partager une même machine bornée par `maxSessions`, et l'egress est industrialisé avec un pool d'IP. C'est la position "poste de travail agent" plutôt que "conteneur jetable".

## État réel

### Code

Le contrat est petit, propre et versionné: `packages/computer-api/src/schemas.ts` (289 lignes), `computer-states.ts` (32), `index.ts` (65), `version.ts` (10). Les schémas couvrent create, status, exec, suspend, resume, attach, detach, delete, plus l'enveloppe d'erreur, avec des types inférés. Les fixtures de test portent un cas valide et un cas invalide par charge utile.

Le provider est le gros morceau: `packages/sandbox-computer/src/provider.ts` fait 1 335 lignes, `client.ts` 358, `local-daemon-proxy.ts` 235, `errors.ts` 68. Le README du paquet documente chaque option de configuration, y compris les secrets: le jeton du contrôleur est résolu depuis une référence de credential, jamais journalisé, et les en-têtes additionnels sont lus depuis l'environnement plutôt que depuis la configuration de session, pour ne pas finir dans les métadonnées de session.

L'intégration dans le runtime est réelle: `packages/runtime/src/sandbox-providers/registry.ts` déclare le slug `computer` avec la description "Runs the agentproto daemon on a self-hosted microVM computer via its controller API (pause/suspend, resume, shared sessions)", `packages/runtime/src/sandbox-adapters.ts` le décrit côté agent, et le Garbage Collector sait maintenant récupérer les boîtes "computer" orphelines.

Ce qui manque et ne se devine pas: le contrôleur de référence lui-même. Les README le décrivent comme existant, avec un registre de modèles qui ne contient aujourd'hui que `base`, `node` et `browser`, et une mention explicite qu'il faut demander à l'administrateur du contrôleur d'enregistrer un modèle poste de travail. Le code du contrôleur n'est ni public ni lisible ici.

### Tests et CI

Le contrat a ses tests: `packages/computer-api/src/__tests__/contract.test.ts` avec les fixtures, et une règle de conception qui fait que la double de test ne peut pas dériver du contrat publié (le faux contrôleur du provider valide tout ce qu'il émet contre les mêmes schémas).

Le provider a six fichiers de test: `provider.test.ts`, `egress.test.ts`, `edge.test.ts`, `noleak.test.ts`, `local-daemon-proxy.test.ts` et `computer-gc.test.ts`, plus un `fake-controller.ts` complet. Le test `noleak` est celui qui compte pour une brique qui manipule des secrets et des identités de session.

La CI de la plateforme couvre ces chemins: les commits récents du 2026-10-20 et du 2026-10-21 touchent précisément le provider, le contrat, le GC et le proxy de session, et ils passent par la gate du dépôt.

### Déploiement

Le contrat est publié sur npm en version 0.2.3 (créé le 2026-10-19, six versions), le provider en 0.3.1 (créé le 2026-10-18, six versions). Les téléchargements sont faibles: 151 par mois pour `@agentproto/sandbox-computer`, et le contrat n'a pas de volume mesurable propre. Aucun contrôleur public, aucun service hébergé, aucun client paie: la flotte est aujourd'hui un actif interne.

Le statut d'egress dans AIP-36 v1.3 indique une infrastructure en cours de durcissement, avec la règle documentée qu'un agent à accès réseau doit déclarer ses destinations, ce qui suppose une politique d'egress par tenant.

### Dernières activités git

L'activité est très récente et concentrée, ce qui indique une brique en construction active et non un projet abandonné:

- 2026-10-20, `ab53381a`: ajout de `egressIp` et des erreurs de capacité, AIP-36 v1.3;
- 2026-10-21, `fb025f0b`: le Garbage Collector récupère maintenant les boîtes "computer" orphelines;
- 2026-10-20, `a63eafb1`: "ne jamais perdre le travail d'une boîte sandbox" (point de contrôle à échéance, poussée de secours, démontage sans capacité);
- 2026-10-20, `43e1fbc9`: détachement et démontage des boîtes computer au kill et au crash.

En amont, `@agentproto/computer-api` est né le 2026-10-19 avec le commit `8b350d5`, qui a aussi fait migrer le provider vers les schémas publiés. Le premier changement du provider (`743fa74`, slug `computer`, suspend valant pause, reprise avec adoption du nouvel identifiant, sessions partagées) date de la même semaine. En résumé, la brique a environ une semaine d'existence publique.

## Ce qu'il faudrait pour en tirer du revenu

Le produit vendable n'est pas la flotte, c'est la machine isolée et durable mise à disposition d'un agent. Le chemin réaliste est celui d'un service infogéré, avec trois étapes:

1. **Répondre à la question "qui paie l'infrastructure".** Une microVM avec snapshot et pause coûte de l'hôte, du stockage et de l'exploitation. En vendre l'usage à l'agent qui le consomme suppose de porter un coût quasi fixe, ce qui n'a de sens qu'avec une base installée ou une flotte mutualisée bien remplie. Le vrai produit vendable est un poste de travail agent garanti: adresse de sortie dédiée, session persistante entre deux tours de l'agent, et un point de contrôle unique pour l'opérateur.
2. **Bâtir l'offre hébergée sur le contrat existant.** Le contrat v1 est déjà assez propre pour être une API publique stable. Il manque l'implémentation de référence (le contrôleur n'est pas public), le tableau de bord opérateur, la facturation à la minute d'occupation, et l Story "poste de travail agent" comme produit empaqueté. Le chemin technique le plus court est de publier le contrôleur de référence en open source, comme Bureau l'a été, et de monétiser l'hébergement plutôt que le code.
3. **Rendre le multi-tenant crédible.** L'egress deny-by-default, le pool d'IP et le `X-Tenant-Id` sont déjà dans le contrat: c'est la bonne base pour vendre du multi-tenant. Il faut y ajouter l'authentification de tenant sérieuse, la comptabilité par tenant (le système d'événements de session existe déjà dans la plateforme), et le nettoyage des snapshots expirés, qui est un coût caché de ce type de service.
4. **Positionner face aux alternatives.** `e2b` (Firecracker hébergé) est déjà dans la plateforme comme fournisseur par défaut, et il a une infrastructure derrière. La différence défendable est la persistance et le partage de session, plus l'egress dédié: il faut la démontrer sur un cas client précis, pas sur une fiche produit.
5. **Traiter le coût d'exploitation comme un produit.** Snapshots, images de modèle, orchestration, reprise après crash, rétention: la liste des echoing travaux déjà visibles dans les commits du 20 octobre. Tant que ces coûts ne sont pas chiffrés par machine et par heure, aucun prix ne peut être fixé.

## Verdict PM

**Non, pas de PM d'exécution à ce stade.** Ce n'est pas un produit vendu mais une brique d'infrastructure au service d'autres projets, dont le code même est absent de l'environnement et dont le contrôleur de référence n'est ni public ni documenté comme livrable. Un PM produit n'a rien à piloter ici: il n'y a ni utilisateur, ni prix, ni surface de distribution. Ce dont le sujet a besoin, c'est d'une décision d'arbitrage à deux branches, à rendre rapidement: soit la flotte reste un actif interne du studio, auquel cas il lui faut un propriétaire d'exploitation et un budget d'hôtes, pas un PM; soit elle devient un service vendu, auquel cas il faut d'abord publier le contrôleur de référence et concevoir un poste de travail agent comme offre nommée, et le PM redevient pertinent à ce moment-là. Le PM doit être embauché au moment du passage de la première à la seconde branche, pas avant.
