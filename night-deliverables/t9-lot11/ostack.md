# ostack

## Perimetre et limites

Le clone local du workspace attendu pour ce projet (`projects/agentik-studio/projects/ostack`) n existe pas dans le bac a sable de cette session: ni `/home/user/projects`, ni aucune copie de l arborescence `agentik-studio` ne sont presentes sur la machine, et le depot prive `agentiknet/agentik-studio` refuse le clone (`403`, jeton PAT sans acces). Aucun fichier du projet lui-meme n a donc pu etre lu.

Ce que j analyse est le depot miroir public `agentiknet/ostack`, qui est un fork de `mr-daedalium/ostack-saas`, lui-meme fork de `garrytan/gstack`. C est la lecture la plus coherente avec la presence du projet dans le workspace. Aucun build et aucune installation n ont ete lances.

## A quoi il sert

ostack est une equipe d ingenierie IA pour Claude Code: une collection de skills (fichiers `SKILL.md`) qui ajoutent au modele des roles et des processus de travail de developpeur senior. Le README le resume par "Your tool to build an Empire using AI. One AI-agent at a time."

Le catalogue de skills est le produit. On compte 28 skills dans le depot:

| Skill | Role |
| --- | --- |
| `autoplan` | planification autonome |
| `browse` | navigateur headless integre (Playwright) |
| `review`, `plan-eng-review`, `plan-ceo-review`, `plan-design-review` | revues par specialite |
| `qa`, `qa-only` | recette et correction de bugs |
| `ship`, `land-and-deploy`, `setup-deploy` | livraison |
| `retro`, `careful`, `canary`, `benchmark`, `office-hours`, `startup` | rites d equipe |
| `company` | structure d organisation (agents, skills, teams) |

Deux briques techniques accountent pour l originalite du projet:

- Le moteur navigateur `browse/`: un serveur Node/Bun qui pilote Playwright, avec validation d URL, import de cookies, selection de cookies, snapshot de page et serveur de test local. C est la partie qui fait le travail reel et la partie qui a le plus de code.
- Le patron de dossier `company/` : a la revision `feat: restructure to company/ folder pattern (agentcompanies/v1)` du 2026-04-15, le projet adopte le standard `agentcompanies/v1` avec `company/agents`, `company/skills`, `company/teams` et un `COMPANY.md`. C est le seul apport propre du miroir, quatre commits en amont du fork amont.

## Etat reel

### Code

251 fichiers suivis, 251 environ, code TypeScript execute par Bun. La racine contient les repertoires de skills, un dossier `browse/` (17 fichiers source, 14 fichiers de test), `bin/` (10 fichiers), `scripts/`, `startup/` (routes, generators, provisioning), `test/` (18 fichiers) et `company/`. Version declaree `0.1.0` dans `VERSION` et `package.json`.

Le projet est distribue en skills, pas en paquet npm: `ostack` n existe pas sur le registre npm. L installation se fait en copiant les skills et en reliant un sous-module (`obrain` via `.gitmodules`).

### Tests

34 fichiers de test. La suite est basee sur `bun test`, avec un decoupage explicite en `test:fast` (tests unitaires de parsing, validation, generation de docs), `test:e2e`, `test:evals` et `test:codex`. Les tests `skill-e2e` et `skill-llm-eval` sont exclus de la suite par defaut, donc ils ne tournent qu explicitement. C est une bonne pratique (les evals IA lentes), mais elle suppose que quelqu un les lance.

### CI

Aucun workflow GitHub Actions. Pas de `.github/workflows` dans le depot. C est le point faible le plus net: le projet a 34 fichiers de test et aucune chaine qui les execute automatiquement.

### Deploiement

Aucun. Pas de paquet publie, pas de conteneur, pas de service. Le produit s installe localement dans le poste de travail et depend entierement de Claude Code.

### Dernieres activites git

52 commits au total, dont 48 en mars 2026 et 4 en avril 2026. Dernier commit le 2026-04-15 (`feat: restructure to company/ folder pattern (agentcompanies/v1)`), dernier push sur GitHub le 2026-04-15. Aucune activite depuis plus de six mois.

Comparaison avec l amont: le miroir est 4 commits en avance et 0 en retard sur `mr-daedalium/ostack-saas`, qui lui-meme est fige depuis le 2026-03-31 (115 etoiles, 19 forks). L amont de l amont, `garrytan/gstack`, est le projet d origine, gratuit et sous licence MIT.

## Ce qu il faudrait pour en tirer du revenu

ostack ne peut pas se vendre tel quel: c est une pile de skills MIT, gratuite, dont la valeur est dans le contenu et pas dans le code. Le nom du fork amont (`ostack-saas`) montre que l ambition existe deja: l outil a ete pense pour devenir un service.

Ce qui manque, par ordre:

1. Un service heberge qui execute la boucle de skills sur le code du client, avec un tableau de bord des runs. C est la que se trouve la valeur: le client paie pour le resultat, pas pour les skills.
2. Un hote de navigateur `browse/` en service, avec gestion des cookies et des proxy. C est la brique la plus difficile a reconstruire et la plus facile a facturer par volume.
3. Une verticalisation. La vente de `ostack` generique ne se defend pas face a `gstack` gratuit. La vente de `ostack` pour une equipe produit precise, avec les skills de revue adaptes, se defend.
4. Une distribution. Sans paquet npm et sans CI, la courbe de diffusion est nulle. Un canal d installation en une commande est un prealable.

## Est-ce qu il merite un PM

Non, en l etat.

Les raisons: le code est un miroir d un projet amont gratuit et fige, il n y a aucune chaine de livraison, aucune activite depuis six mois, et la valeur est dans le contenu editorial des skills, pas dans une roadmap technique a piloter. Un PM n aurait rien a arbitrer tant que la decision de reprise n est pas prise.

Ce qui changerait la reponse: le lancement effectif de la version hebergee, ou la decision de faire de `company/` (le standard `agentcompanies/v1`) un produit a part. Dans ce dernier cas, la reponse devient oui, parce qu il y a un standard a faire adopter et une communaute a animer.
