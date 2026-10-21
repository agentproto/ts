# arkor

## Perimetre et limites

Le clone local du workspace attendu pour ce projet (`projects/agentik-studio/projects/arkor`) n existe pas dans le bac a sable de cette session, et le depot prive `agentiknet/agentik-studio` refuse le clone (`403`, jeton PAT sans acces). Aucun fichier du projet n a donc pu etre lu.

J analyse le depot miroir public `agentiknet/arkor`, fork de `arkorlab/fine-tuning`. Aucun build et aucune installation n ont ete lances.

## A quoi il sert

arkor se presente comme "The TypeScript framework for fine-tuning open-weight LLMs". L intention est de rendre le fine-tuning aussi naturel qu une application TypeScript: un SDK type-safe, une CLI, et un Studio local (interface web) pour lancer et suivre les runs, avec des GPU geres.

L architecture est un client d un service heberge: `packages/arkor/src/core/client.ts` appelle une API `baseUrl` avec des routes `/v1/jobs`, `/v1/jobs/{id}/events/stream` (SSE pour le streaming des checkpoints) et `/v1/inference/chat`. L authentification passe par Auth0 (`core/auth0.ts`), les identifiants par `core/credentials.ts`, et les evenements declenchent les callbacks typees `onStarted`, `onLog`, `onCheckpoint`, `onCompleted`, `onFailed` prevus par le code.

Le SDK propose aussi trois recettes de fine-tuning LoRA sur des modeles ouverts (Gemma) avec des jeux de donnees HuggingFace: `triage`, `translate`, `redaction`. Le Studio (`packages/studio-app`, React) affiche la liste des jobs, la courbe de perte, les logs et un playground.

## Etat reel

### Code

321 fichiers suivis, monorepo Turborepo avec 4 paquets: `arkor` (SDK et CLI, version `0.0.3-alpha.1`), `cli-internal`, `create-arkor` (generateur de projet, version `0.0.3-alpha.1`) et `studio-app`. Le coeur du SDK est en 30 modules dans `packages/arkor/src/core`: client, modeles, schemas, trainer, runner, state, telemetry, deprecation, deployements, projectState, upgradeHint.

### Tests

63 fichiers de test, dont les tests sont colocalises avec le code (`*.test.ts` dans `src/core`): client, client.deployments, models, schemas, trainer, runner, state, telemetry, credentials, auth0, arkor, version. La couverture est serieuse pour un alpha, et le code de test verifie des details metier (forme des identifiants HuggingFace, formes des evenements, comportement de deprecation).

### CI

5 workflows: `ci.yaml`, `build.yaml`, `codeql.yaml`, `release.yaml` et `release-dry-run.yaml`. La CI est exigeante: un garde-fou `no_em_dash` qui scanne tous les fichiers suivis, une matrice de systemes d exploitation et de versions de Node, et typecheck, lint, tests et build. La publication npm est protegee par provenance (`pnpm publish --provenance`) avec verification de visibilite du paquet sur le registre.

### Deploiement

Le SDK est publie sur npm sous le nom `arkor`: version `0.0.3-alpha.1`, 12 versions au total, derniere publication le 2026-07-22, environ 123 telechargements sur 30 jours. Le service `arkor.ai` heberge l entrainement et l inference sur GPU.

### Dernieres activites git et statut reel du produit

Le miroir compte 313 commits, de mai a aout 2026 (184 en mai, 27 en juin, 85 en juillet, 17 en aout). Dernier commit le 2026-08-04, dernier push le 2026-08-05. Il est 117 commits en avance et 283 commits en retard sur l amont `arkorlab/fine-tuning`: le miroir a diverger.

Le fait le plus important du dossier est dans l amont, pas dans le miroir. Le README de `arkorlab/fine-tuning` affiche aujourd hui:

> The arkor.ai fine-tuning service has been discontinued, and this framework is no longer maintained. The source code and contribution history will remain publicly available under the MIT license.

Et la suite: "The hosted training and inference services are no longer available. No further updates, bug fixes, or releases are planned." Le projet a ete repris sur `arkor.dev`.

Concretement: le miroir du workspace est une photo de l outil avant l arret, en alpha, sans arriere-plan heberge. Le service sur lequel il depend n existe plus.

## Ce qu il faudrait pour en tirer du revenu

Il faut etre lucide: le produit tel quel est mort, parce que sa valeur, c etait l entrainement heberge, et que le service est arrete. Les options reelles sont:

1. Une reprise de service de fine-tuning heberge. Les GPU se louent, les modeles ouverts sont de plus en plus bons, et le SDK, les schemas et le Studio sont deja ecrits. Mais le marche est tres bruyant (Unsloth, Axolotl, OpenPipe, Together, Modal, Replicate) et un produit de plus a prix plein ne se defend pas par la qualite du code.
2. Une niche que personne ne veut: fine-tuning local ou souverain, sur un seul GPU de bureau, sans envoi de donnees. C est coherent avec l ageosysteme, et le Studio local du projet va dans ce sens. Il faut alors remplacer le backend par un runner local (vLLM, llama.cpp, ou un adaptateur vers un trainer Python) et garder le SDK comme facade.
3. Une recuperation de la valeur par la formation ou par le consulting: le code reste un bon support pedagogique pour comprendre un fine-tuning de bout en bout, meme sans service.

Ce qu il ne faut pas faire: republier le SDK npm en alpha en espérant que quelqu un s y abonne. 123 telechargements par mois sur une dependance cloud morte, c est zero revenu.

## Est-ce qu il merite un PM

Non, pas maintenant.

Le service est arrete, le miroir est en alpha, le SDK n a pas d utilisateur reel, et la decision structurante (relancer un service de fine-tuning heberge, ou se replier sur du local) est un choix de direction avant d etre un travail de PM. Ce que le PM pourrait faire, une fois la direction tranchee, c est de transformer le SDK alpha en un outil documente et fiable sur un backend local, ce qui est une tache d execution plus qu de pilotage.

Le seul element qui meriterait une decision explicite et rapide: ne pas laisser un paquet npm publie et un mirror actif d un service arrete. C est un sujet de hygiene, a traiter avant toute autre chose.
