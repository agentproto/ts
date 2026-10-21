# guilde

## Périmètre de lecture

Le clone local du workspace attendu pour ce projet (`projects/agentik-studio/projects/guilde`) n'était pas présent dans le conteneur d'exécution: ni `/home/user/projects`, ni aucune copie de l'arborescence `agentik-studio` n'existent sur la machine, et le dépôt GitHub du produit est privé pour le jeton d'accès de la session. Aucun code Guilde n'est donc lisible ici. L'analyse a été reconstruite sur les sources publiques disponibles: la documentation produit servie sur `guilde.work` (accueil, pricing, quickstart, concepts), le registre `llms.txt` des docs, les pages publiques de l'éditeur Agentik, et la surface d'intégration Guilde visible dans `agentproto/ts` (plugins, runtime profiles, tunnels, serveur MCP, tools MCP Apps). Aucun build et aucune installation n'ont été lancés.

## À quoi il sert

Guilde est le produit principal d'Agentik SAS, positionné comme "AI teammates. As simple as Slack": une plateforme web où une guild, c'est-à-dire une entreprise IA, regroupe des opérateurs IA au rôle défini, des membres humains, des workspaces, des conversations, des work items, des routines, des connecteurs, des skills, des canaux et un coffre de secrets.

Le modèle mental tient en cinq concepts, documentés sur le site:

- Guild: le conteneur, "votre entreprise IA". Tout est scopé à la guild, chaque URL commence par `/g/<slug>/`. Une guild appartient à un membre ou à une organisation.
- Operator: un travailleur IA avec un vrai poste (persona, traits, capacités), qui tient un contexte, escalade et travaille de façon autonome.
- Conversation: un fil de discussion entre humain et opérateur, distinct des work items.
- Work item: les livrables suivis, hiérarchisés en Objectives, Initiatives et Tasks.
- Workspace: la racine de stockage de fichiers que les opérateurs lisent et écrivent.

Autour, la couche capacité distingue Actions (verbes exécutables), Integrations (catalogue d'installation), serveurs MCP (outils apportés par l'utilisateur) et Skills (paquets de capacité nommés). La couche opérationnelle ajoute les runtimes (daemons, sandboxes, agent CLIs, terminaux), les workstations (coquilles cloud longues durée pré-câblées avec agentproto et les clés de connecteurs), un panneau navigateur (sessions live, tunnel navigateur local, enregistrements), les bases de connaissance par guild (GBrain en hybride graphe plus vecteur, ou Qdrant en vectoriel seul), les notifications, les secrets chiffrés, les routines planifiées et la facturation à crédits. Les opérateurs sont joignables sur Discord, Slack et Telegram, et se branchent sur des CRM comme HubSpot ou Salesforce.

Le lien avec `agentproto/ts` est direct et documenté dans le dépôt: le plugin npm `@guilde/agentproto-bridge` fournit un substrate `guilde-mcp` (endpoint `https://guilde.work/mcp`) et un exécuteur `db-operator`, le runtime profile `@guilde/runtime-profile-guilde` installe une configuration Guilde dans le CLI, le tunnel passe par `wss://guilde.work/api/v1/agentproto/tunnel`, et le runtime sait résoudre un serveur MCP nommé `guilde-prod` ainsi que des tools de type `mcp__guilde__dashboard`.

## État réel

Code: illisible dans cet environnement (dépôt privé, clone local absent). Ce que l'on peut établir par les traces publiques: le produit est une application web Next.js (routes `_next`, assets servies en `/_next/image`), adossée à une API `/v1/...` documentée par endpoint (guilds, operators, conversations, tasks, assets, work-items, templates, API keys), avec authentification JWT ou clé API, une passerelle MCP en JSON-RPC et un tunnel WebSocket pour le navigateur local. Le moteur d'exécution s'appuie sur agentproto et sur les agent CLIs (Claude Code, Codex, OpenCode, Hermes, OpenClaw) pilotés sous gouvernance d'opérateur.

Tests et CI: non observables côté dépôt public. Le seul corpus de tests visible est celui de `agentproto/ts`, où Guilde apparaît comme cas d'usage dans les tests (résolution MCP, config Codex, tunnel, MCP Apps), pas comme un composant testé.

Déploiement: en production et monétisé. `guilde.work` répond, sert le pricing, propose un essai de 14 jours sans carte bancaire et une inscription avec choix de langue (EN, FR, ES, AR). Le tunnel, le MCP et la CLI agentproto sont exposés publiquement. La documentation produit est très fournie, une quarantaine de pages (concepts, capability, operations, reach, settings, tutorials, API reference).

Dernières activités git: non accessibles pour Guilde (dépôt privé). Les dates exploitables viennent du produit: snapshot web.archive du 2026-07-23 pour `guilde.work`, mentions légales Agentik SAS avec année 2026. Le repo `agentproto/ts`, lui, est très actif (commits quotidiens en octobre 2026) et continue d'entretenir l'intégration Guilde.

Point de vigilance: la documentation Guilde est servie depuis le même registre que Katchy, Simone et les specs, avec des liens internes qui pointent vers une IP locale (`0.0.0.0:8080`). Le site public fonctionne, mais une partie des liens croisés du registre est cassée pour un lecteur externe, ce qui dégrade la perception de maturité du produit.

## Ce qu'il faudrait pour en tirer du revenu

Le revenu existe déjà: trois paliers (Starter 20 dollars par mois avec 2200 crédits, Pro 50 dollars avec 5500 crédits, Team 100 dollars avec 11500 crédits et 5 sièges), essai gratuit, BYOK acceptés sur tous les paliers pour contourner la facturation à crédits. Le problème n'est donc pas la monétisation de base mais son rendement. Leviers prioritaires:

1. Rétention et conversion de l'essai vers le payant. Un essai de 14 jours sans carte se transforme rarement. Encaisser dès le premier jour ou à l'épuisement du crédit de démarrage, avec un déclencheur de conversion simple (premier opérateur embauché, premier connecteur installé).
2. Redéfinir l'unité de valeur. Le crédit est difficile à comprendre pour un acheteur non technique. Un packaging par résultat (par exemple une équipe de SDRs prête à l'emploi) ou par workspace rend la décision d'achat évidente.
3. Exploiter le canal grand public. Les operators et les skills sont la matière première du produit, donc un catalogue de skills et un store de connecteurs peuvent devenir des places de marché avec prise de commission, ce qui crée un effet de réseau que l'abonnement seul ne donne pas.
4. Capitaliser sur le canal open source voisin. `opena gentik` (standards et catalogue d'agences) est le meilleur générateur de leads vers Guilde, à condition de le remettre en mouvement, ce qu'il n'a plus fait depuis avril 2026.
5. Sécuriser la dépendance à agentproto: Guilde repose sur le runtime et sur les agent CLIs. Une rupture de compatibilité ou de licence sur le runtime open source est un risque de revenu direct.

## Verdict PM

Oui, PM dédié et à temps plein. C'est le seul projet du lot qui a un produit en production, une tarification active, une documentation dense et une intégration profonde avec le runtime interne. Il manque surtout un propriétaire de roadmap: onboarding et packaging non arbitrés, essai gratuit qui fuit, unité de prix qui n'explique rien au client, documentation dont les liens croisés sont cassés, canal d'acquisition open source à l'arrêt. Le périmètre du PM est net: packaging et onboarding, rétention de l'essai, place de marché des skills et connecteurs, gouvernance de la dépendance au runtime.
