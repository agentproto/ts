# openagentik

## Périmètre de lecture

Le clone local du workspace attendu pour ce projet (`projects/agentik-studio/projects/opena gentik`) n'était pas présent dans le conteneur d'exécution: ni `/home/user/projects`, ni aucune copie de l'arborescence `agentik-studio` n'existent sur la machine, et le dépôt GitHub correspondant est privé pour le jeton d'accès de la session. L'analyse ci-dessous a donc été reconstruite sur les sources publiques du projet: l'organisation GitHub `openagentik` (7 dépôts publics, clonés et lus), les manifests publiés dans `agentproto/ts` qui référencent ce projet, et les pages publiques du produit. Aucun build et aucune installation n'ont été lancés.

## À quoi il sert

`opena gentik` est le bras open source d'Agentik, la société qui édite Guilde, Simone et Katchy. Ce n'est pas une application: c'est une curation de standards et un catalogue de fichiers, sur le modèle d'un "monorepo d'agences IA".

Concrètement, l'organisation regroupe 7 dépôts:

- `openagentik/stack`: la pièce maîtresse. Un README bilingue (FR/EN), 6 documents d'audience (solo founders, non-coders, developers, agencies, contributors, FAQ) et `STACK.md`, une description YAML de type BOM (bill of materials) qui déclare les couches du stack: spec `agentagencies/v1`, catalogue d'agences, format de skills `SKILL.md`, runtime MCP, design kit, canevas, starter packs. `start.sh` est explicitement marqué "Status: PLACEHOLDER".
- `openagentik/companies`: le catalogue. 340 fichiers versionnés, 2 agences complètes vendored: `paperasse` (bureaucratie française: compta, notariat, fiscalité, copropriété, 6 agents, 6 skills) et `ostack` (équipe logicielle façon Claude Code, 5 agents, 28 skills, fork de gstack). Chaque agence respecte le layout `agentagencies/v1` (COMPANY.md, teams/, agents/, projects/, tasks/, skills/).
- `openagentik/templates`: 3 patronymes d'agences prêtes à forker (`minimal`, `solo-founder`, `small-team`) plus un validateur JS zéro dépendance.
- `openagentik/cli`: un seul fichier, un README qui annonce `npx openagentik init / add / run`.
- `openagentik/mcp`: un seul fichier, un README qui annonce un pipeline "coerce" MCP et des connecteurs (Notion, GitHub).
- `openagentik/awesome-agentik` et `openagentik/.github`: coquilles vides.

La spec `agentagencies/v1` elle-même est hébergée à part (`agencies-sh/spec`), et le README de `openagentik/stack` revendique explicitement cette spec comme écrite par l'organisation, ce qui est cohérent avec le même éditeur.

## État réel

Code: il n'y a presque pas de code. Sur les 7 dépôts, 2 sont des coquilles (`.github`, `awesome-agentik`), 2 sont un README seul (`cli`, `mcp`), 2 sont de la documentation (`stack` avec 13 fichiers, `templates` avec 32 fichiers de markdown plus un validateur), 1 est un catalogue de fichiers markdown avec 340 fichiers. Aucun `package.json` dans l'organisation, donc aucun paquet publié: les 4 paquets annoncés dans `STACK.md` (`@openagentik/mcp-coerce`, `@openagentik/mcp-connectors`, `@openagentik/mcp-connector-notion`, `@openagentik/mcp-connector-github`) n'existent pas sur npm (404), et `@openagentik/cli` non plus. Aucun artefact, aucun binaire.

Tests: aucun test unitaire dans l'organisation. Le seul contrôle automatique est `scripts/validate-agentcompanies.js`, un validateur de frontmatter YAML maison qui vérifie que les références (`manager`, `reportsTo`, `skills`, `assignee`, `project`, `dependsOn`) résolvent à l'intérieur d'une agence et refuse les références entre agences. C'est un vrai garde-fou sur 340 fichiers, mais c'est de la validation de structure, pas de la couverture de comportement.

CI: une seule chaîne, dans `openagentik/companies` (`.github/workflows/validate.yml`, Node 20, `node scripts/validate-agentcompanies.js`, sur push sur main et sur PR). Les 6 autres dépôts n'ont aucun workflow, donc aucune vérification sur `stack`, `templates`, `cli` et `mcp`.

Déploiement: aucun. Aucun release, aucun tag, aucun registre de paquets. Le produit distribué est un copier-coller de dossier: le README dit "drop it into any agentcompanies/v1-compatible runtime (Paperclip, Guilde, etc.)".

Activité git: le projet est né et mort en 24 heures. Les 7 dépôts sont créés entre le 2026-04-26 21:32 et le 2026-04-26 23:00, le dernier push date du 2026-04-27 01:14. `stack` compte 6 commits, `companies` 2, les 4 autres 1 chacun. Aucun commit depuis environ six mois. 0 star, 0 fork, 0 issue ouverte partout, et aucun fork public du projet alors que c'est précisément l'usage annoncé ("fork one, plug in your keys, ship tonight").

Point important et contre-intuitif: le code applicatif d'`opena gentik` n'est pas dans ces dépôts. `agentproto/ts` embarque un test de parité dédié, `packages/model-routing/src/__tests__/parity-openagentik.test.ts`, qui reimplémente la formule de `packages/core/src/routing/virtual-resolve.ts` du router openagentik (résolution sticky d'un modèle virtuel par hash FNV-1a du préfixe de conversation). Le test est vert côté `agentproto/ts`, mais le router d'origine est hors GitHub public: il vit dans un dépôt privé. Autrement dit, la partie qui produit de la valeur (le routage multi-modèles) est privée et non documentée, et la partie publique est la vitrine.

## Ce qu'il faudrait pour en tirer du revenu

Aujourd'hui, le revenu direct est nul: licence MIT, zéro donation, zéro paquet publié, zéro traction communautaire. Trois chemins réalistes, par ordre de rendement:

1. En faire un canal d'acquisition pour Guilde. C'est déjà la logique affichée dans `stack`, qui liste Guilde comme runtime fermé. Il manque un guide "vendeur plus Guilde" qui transforme un catalogue de skills en compte payant, et un suivi des conversions. Le catalogue `paperasse` est le meilleur angle d'attaque: la bureaucratie française est un segment que les agences concurrentes ne couvrent pas.
2. Monétiser le service autour du CLI et du MCP. Tant que `npx openagentik init` n'existe pas, il n'y a pas de surface d'entrée. Le minimum est de publier `@openagentik/cli` (même minimal) et un connecteur, puis de vendre l'installation et la mise en conformité d'une agence.
3. Vendre l'expertise: audit et mise en conformité `agentagencies/v1` pour les agences qui veulent tourner dans Guilde ou Paperclip, en servant le validateur comme outil d'entrée gratuit. C'est le levier le plus rapide à encaisser, car il ne demande aucun code supplémentaire.

Il faut aussi arrêter de promettre ce qui n'existe pas. Les README de `cli` et `mcp` annoncent des commandes et des paquets non publiés: chaque contradiction entame la crédibilité du reste du stack, y compris de la spec `agentagencies/v1`.

## Verdict PM

Oui, mais un PM à temps partiel, centré cadrage et non exécution. Les raisons: le projet porte deux promesses non livrées (CLI et MCP) et un standard public qu'il revendique, alors qu'il n'a ni CI sur 6 dépôts sur 7, ni paquet publié, ni activité depuis six mois. Il y a une décision à prendre (relancer, fusionner dans l'OSS de Guilde, ou geler) et personne ne l'a prise. En revanche, un PM temps plein serait disproportionné: le code est quasi inexistant et le vrai sujet est un choix de positionnement, pas un backlog produit.

Points d'attention pour ce PM: trancher entre relance OSS et usage interne, faire livrer le CLI ou retirer la promesse, porter la CI sur l'ensemble de l'organisation, et clarifier la frontière entre le public (standards, catalogue) et le privé (router, runtime), frontière aujourd'hui floue et contestable.
