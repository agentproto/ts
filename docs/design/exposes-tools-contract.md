# Contrat de conception: `exposes.tools` (APP.md), 2026-11-08

Document seul, aucun code. `ts/` = `projects/agentproto/ts` (repo à part, `ts/AGENTS.md` s'applique: `pnpm gate`, changeset par PR, jamais `gh pr merge`). Lignes = état du checkout `1524e2a14`, relues pour ce document. « Je pense » = non vérifié.

## 1. Déclaration et validation

```yaml
exposes:
  agents: [...]            # existant
  workflows: [...]         # existant
  prefix: jobkit           # obligatoire dès que tools est non vide
  tools:
    - id: jobkit.leads.upsert    # id d'un TOOL.md bundlé (ou imported:<alias>/<tool>)
      access: write              # read | write | approve
      description: "..."         # obligatoire, <= 300 car., écrite pour un modèle
      inputSchema: {...}         # optionnel, défaut = `inputs` du TOOL.md
      mcpName: jobkit_leads_up   # optionnel, voir §2
      approvalArg: nonce         # optionnel, access=approve seulement
```

Aujourd'hui `exposes` = `{agents, workflows}` (`app/src/types.ts:596`), parsé en `app/src/manifest-fields.ts:831-850`, émis `emit.ts:215`, figé `define-app.ts:126`, copié sur l'installé `runtime/src/app-tools.ts:1706` et `app-registry.ts:82`. Règles (erreur au load, pas au premier appel):
1. `prefix` : `^[a-z][a-z0-9]{1,15}$` (pas de `_`, le premier `_` du nom MCP est donc un séparateur sûr), absent des premiers segments de `DAEMON_TOOL_NAMES` (`runtime/package.json:187`, liste générée, donc pas de liste réservée à la main).
2. `id` unique, et résolu par `loadAppBundledTools` (`app/src/load-app-tools.ts:236`). Un id de tool démon (`app_run`, `app_data_write`, ...) est refusé: il reste réservé à l'UI via `ui.tools`. Un id `imported:` est accepté seulement avec `mcpName` explicite, à toute classe d'accès (`read`, `write`, `approve`), avec les mêmes règles de visibilité qu'une entrée bundlée (2026-11-08: Bureau expose ses outils navigateur d'écriture).
3. `access: read` refusé si le TOOL.md porte `mutates` non vide ou un tag `mutator`/`write` (`TOOL.md` job kit: tags `read|write|mutator`, `risk_level`; aucun n'a de `mutates:`, vérifié par grep, donc ce sont les tags qui portent la règle).
4. Aucun `id` ni `mcpName` ne matche `^approval` (le test `bureau/tests/app-md-safety.test.mjs` fait déjà ce contrôle sur `ui.tools`, d'après `bureau APP.md:32-37`, non relu): aucun outil qui décide ne passe par ce registre.
5. `approvalArg` n'a de sens que pour `approve`. Ce n'est qu'un contrôle de forme (l'arg est présent); la vraie garantie reste `consume` du moteur (hash du payload, `not_requester`, `approvals/engine.ts:107`).
6. Temporaire, levé par la PR2: tout id non `imported:` doit aussi être dans `ui.tools` (la route `/apps/:appId/tool-call` n'accepte que `ui.tools`, `app-tools.ts:844`).

## 2. Nom MCP

`<prefix>_<n>` où `n` = `id` privé du préfixe de tête (`<prefix>.` ou `<prefix>_`), puis tout caractère hors `[a-zA-Z0-9_-]` remplacé par `_`, `_` répétés fusionnés. `jobkit.pipeline.kit_begin` -> `jobkit_pipeline_kit_begin`; `bureau.status` -> `bureau_status`. Longueur <= 64 (je pense: limite de certains clients; le plus long job kit fait 27). `mcpName` remplace `n` seulement (même validation, le préfixe reste imposé), obligatoire pour `imported:` (`imported:bureau/browser_list_instances` n'a ni `:` ni `/` acceptables, constat `mcp-app-test-lecture.md`).
Une seule fonction `exposedToolName(prefix, entry)` dans `packages/app` (nouveau `exposed-tools.ts`), importée par le CLI et le démon (règle AGENTS.md « même règle dans deux moteurs »). Le `mcpName()` de `mcp-server/src/to-mcp-tool.ts:129` (`[-:.]` -> `_`) sert le serveur autonome sans préfixe et n'est pas touché.
Collisions: (a) dans une app, deux entrées au même nom: erreur au load. (b) deux apps au même `prefix`: `app_install` (`app-tools.ts:1514`) refuse la seconde (même `appId` = réinstallation, permis). (c) nom égal à un tool racine/`app_ui_*`: le tool est ignoré avec `console.warn`, comme `app-ui-apps.ts:432-438`, et `app_status` liste `skipped:[{name,reason}]`.

## 3. Enregistrement côté démon

- Le gateway `/mcp` reconstruit son serveur à CHAQUE requête (`mcpServerFactory`, `runtime/src/index.ts:4217`, commentaire « once per /mcp request » en 4281-4284). Les panneaux d'app y sont ajoutés en `4888-4893` (`makeInstalledAppUiApps`, `app-ui-apps.ts:418`, boucle sur `appRegistry.listApps()`). Nouveau `registerExposedAppTools(server, {appRegistry, access, callerSessionId, ...})` dans un fichier `runtime/src/app-exposed-tools.ts`, appelé juste après 4893: il est donc APRÈS `withToolExclusion` (`?denyTools`, 4336) et `withToolSubset` (`?allowTools`, 4342, avec préfixe `jobkit_*` supporté par `isAllowedBySubset`, `tool-subset.ts:20-26`), qui s'appliquent donc d'office.
- Exécution: factoriser la branche bundlée de `dispatchAllowlistedAppTool` (`app-tools.ts:891-899`, `loadAppBundledTools` + `runTool`) en helper; nouveau `performExposedToolCall(appRegistry, {appId, id, args, callerSessionId})` qui vérifie l'appartenance à `exposes.tools` (pas `ui.tools`). `performAppToolCall` (`app-tools.ts:922-939`) et le verbe `app_tool_call` (`:3463`) ne changent pas.
- Rechargement: aucun cache à invalider, `appRegistry.upsertApp` (install `:2349`, `app_resync` `:2462`, auto-repoint `recordRepoint` `:1897`) est lu à la requête suivante. Limite: un client MCP qui garde sa liste d'outils ouverte ne la voit changer qu'à la reconnexion (je pense: le transport stateless ne peut pas pousser `tools/list_changed`).
- Schéma d'entrée réel: `inputSchema` ou `inputs` du TOOL.md converti comme `zodFromJsonInputs` (`to-mcp-tool.ts:119`), annotations MCP `readOnlyHint` (read) / `destructiveHint` (write, approve) via `resolveAnnotations` (`to-mcp-tool.ts:~142`).
- CLI `agentproto mcp-app <appId>` (`cli/src/commands/mcp-app.ts`): remplace la boucle `:100` (`readDeclaredUITools`, `:86`) par les entrées `exposes.tools` filtrées par `--access read` (défaut; `--access read,write,approve` explicite), nom calculé, schéma réel, redirection vers `POST /apps/:appId/tool-call` avec l'id d'origine (`callScopedTool`, `:140`). `readDeclaredUITools` (`app-serve.ts:566`) lit le YAML brut sans validation: ajouter `readDeclaredExposedTools` qui passe par le validateur partagé. `app-mcp-server.ts` (standalone, `:52-54`) reste sur `ui.tools`, hors périmètre.

### Outils importés et vues `ui://` (2026-11-08)

Un id `imported:` se comporte sur le gateway comme l'outil d'origine: `performExposedToolCall` rend le `CallToolResult` de l'import tel quel (blocs, `structuredContent`, `isError`, `_meta`), `registerExposedAppTools` recopie son `_meta.ui` sur `tools/list` (depuis la liste en cache du registre d'imports), et une entrée qui déclare `inputSchema` ne transmet que les clés déclarées. `exposes.resources: string[]` (URI `ui://` distinctes, au moins une entrée `imported:`) est la liste blanche des vues: le gateway enregistre ces URI seulement et relaie leur `resources/read` vers les imports de l'app; toute autre URI reste inconnue, et `resources/list` n'est jamais relayé en entier. La route `/apps/:appId/tool-call` garde son enveloppe texte. La session appelante est transmise à l'import (Bureau y attache la propriété des onglets).

### Refus par entrée (2026-11-08)

Le gateway revalide chaque enregistrement (apps.json peut être édité à la main) entrée par entrée, avec `checkExposedTools`: une entrée invalide est ignorée seule, avec un `console.warn` qui nomme l'app, l'outil et la raison, et ses voisines restent enregistrées. Seule une faute de liste (préfixe invalide ou réservé, `tools` qui n'est pas un tableau) ignore toute l'app. Au chargement d'un APP.md (`defineApp`, `loadAppHandle`, `app_install`), la validation reste stricte: une erreur d'auteur refuse le manifeste.

## 4. Politique par agent

- `read`: enregistré pour tout appelant, sauf coupe-circuit opérateur `defaults.apps.exposedTools: "read"(défaut)|"off"|"all"`, relu à la requête comme `resolveMessagingDefaults` (`index.ts:~4287`).
- `write` et `approve`: enregistrés seulement si l'appelant a opté. L'agent le dit dans son AGENT.md: `tools: [{kind: mcp, server: agentproto, allow: ["jobkit_leads_upsert","jobkit_pipeline_*"]}]`. Le type existe (`McpToolRef`, `agent/src/types.ts:23`) mais `allow` n'est lu nulle part au gateway (je pense; seul `deny` l'est: `toolDenyGrants`, `operator/src/resolve-tools.ts:224`, `spawn-agent-manifest.ts:150`). PR2 ajoute `exposedToolOptIn: string[]` sur le descripteur de session, calculé au même endroit que `toolDenyGrants`, lu en `index.ts:4257` (`sessions.get(callerSessionId)`).
- Ou bien l'app de l'agent l'accorde: `requires.apps[].tools` (AIP-53, section Requirements) liste des noms MCP du fournisseur (`bureau_navigate`), jamais des ids. Une session lancée depuis un AGENT.md de l'app consommatrice reçoit ces outils à la classe d'accès du fournisseur, comme si son AGENT.md avait opté par nom. L'attribution est celle du démon au lancement: `meta.appAgent` (posé par `app_run`, porté par restart et continue-fresh, jamais hérité par un enfant) ou `meta.agentManifestPath` égal à un `agents[].path` de l'app. Aucun autre appelant ne gagne rien. Tout ou rien par entrée: fournisseur absent, version hors plage ou nom plus exposé, l'entrée n'accorde rien. À l'install ou au rechargement du consommateur, un nom que le fournisseur installé n'expose pas refuse l'install (`requires.apps[i].tools[j]: ... is not exposed by ...`); un fournisseur absent n'empêche pas l'install, et `app_install` comme `app_list` rapportent `unmetRequires: [{ id, reason: not-installed | version-mismatch | tool-not-exposed }]`, recalculé à chaque lecture. `off` et les règles deny gagnent sur l'accord.
- `deny` gagne toujours (`tool-deny-gate.ts`): à vérifier par test que les tools enregistrés par `registerExposedAppTools` passent bien par `gatedServer` (4258) et pas par le `rawServer`.
- Route REST `/apps/:appId/tool-call`: un outil exposé `write`/`approve` exige une session appelante (même confiance que `?callerSessionId=` / `x-agentproto-caller-session-id` sur `/mcp`) plus son opt-in, un accord `requires.apps` ou le mode `all`; sans session c'est refusé, même en `all`. `mcp-app` transmet `AGENTPROTO_SESSION_ID` comme session appelante.
- Appelant sans `callerSessionId` (opérateur humain, client externe): `read` seul via `mcp-app`; sur `/mcp` il est traité en opérateur (`approvals/tools.ts` en-tête), donc je recommande qu'il reste en `read` + opt-in explicite par `?allowTools=` (la sémantique opérateur existante).
- `approve`: l'outil existe pour l'agent (ex. `jobkit.decide` avec `approvalId`), mais la décision humaine ne passe que par la carte (`/mcp?surface=approval-cards`, `approvals/card-surface.ts:1-4`; `approval_request|get|wait|consume` sans « decide », `approvals/tools.ts`). Le registre refuse tout id `approval*` (règle 4) et n'ajoute aucun outil de décision. Qui demande ne décide pas: `not_requester` (`engine.ts:107`).

## 5. Rétrocompatibilité avec `ui.tools`: migration explicite, pas de dérivation

Je tranche: aucune dérivation automatique « tout en read ». Dériver depuis `ui.tools` exposerait `jobkit.decide`, `mark_sent`, `app_data_write`, `app_run` (40 outils job kit, confirmé par le test du 2026-11-08) comme lectures: échec ouvert, exactement le défaut actuel. Donc: sans `exposes.tools`, une app n'expose RIEN de nouveau au gateway; `app_tool_call` + `ui.tools` restent inchangés (aucune régression, la surface agent actuelle persiste via le verbe générique). `mcp-app` sans `exposes.tools` garde son comportement actuel avec un avertissement stderr (il sert des bundles de livres à des clients tiers, `mcp-app.ts:1-4`). `agentproto app validate` (`cli/src/commands/app-init.ts:338`) avertit « ui.tools non classé » et peut PROPOSER une classification d'après les tags TOOL.md, sans jamais écrire `read` seul (`jobkit.digest` écrit un rapport sans tag `mutator`: une heuristique de tags se tromperait).

## 6. Découpage en 2 PR (depuis `main`, pas empilées)

PR1 (~250-300 lignes, ts/): schéma, validation, nommage, filtre lecture dans `mcp-app`. Fichiers: `app/src/{types,manifest-fields,emit,define-app,load-app,exposed-tools}.ts`, `cli/src/app-serve.ts`, `cli/src/commands/mcp-app.ts`, doc `docs/cli/verbs/mcp-app.md` (je pense qu'il est généré/vérifié par `docs.mjs --check`), ce contrat en `docs/`, changeset (app, cli). Tests qui échouent avant: `exposes.tools` accepté (avant: rejeté ou ignoré), `read` refusé sur tag `mutator`, `approval_x` refusé, collision interne refusée, `exposedToolName("bureau","imported:bureau/x",mcpName)` = nom sans `:`/`/`, `mcp-app` n'enregistre pas un tool `write` par défaut (avant: tout `ui.tools`), schéma réel au lieu de `{args}`.
PR2 (~300-400 lignes, ts/): attend la fusion de PR1 (importe `exposedToolName`; pas de PR empilée, branche depuis `main` après merge). `runtime/src/app-exposed-tools.ts`, `index.ts` (+1 appel), `app-tools.ts` (helper + `performExposedToolCall` + refus de préfixe pris à l'install), `app-registry.ts` (champ `exposes.tools`/`prefix` persistés dans `apps.json`), `sessions.ts`/`spawn-agent-manifest.ts` (`exposedToolOptIn`), config `defaults.apps.exposedTools`, lève la règle 1.6. Tests qui échouent avant: après `app_install`, `tools/list` du gateway contient `jobkit_list` (avant: absent) sans redémarrage; un appelant sans opt-in ne voit pas `jobkit_leads_upsert`, avec opt-in il le voit; un deny AGENT bloque l'appel; préfixe déjà pris: 2e install refusée; coupe-circuit `off`; `DAEMON_TOOL_NAMES` inchangé (test existant).
PR3 (agentik-studio, après PR2 et un redémarrage du démon par Jeremy): §7.

## 7. Migration (agentik-studio, `projects/agent-apps`)

Bureau, `prefix: bureau`, tout `read`: `bureau.status` -> `bureau_status`, `bureau.setup` -> `bureau_setup`, `bureau.overview` -> `bureau_overview`, `imported:bureau/browser_list_instances` -> `bureau_list_instances` (`mcpName`). Aucun write/approve exposé (les cartes d'approbation sont la surface humaine). Étendre `tests/app-md-safety.test.mjs` à `exposes.tools`.
Job kit, `prefix: jobkit` (27 TOOL.md; les 13 tools démon de `ui.tools` ne sont pas exposés):
- read (13): `list, read, status, verify, policy.get, approval.status, offers, sources, ranking, history, network, leads.list, counts`.
- write (12): `pipeline.init, pipeline.draft, pipeline.gate, pipeline.jury, pipeline.revise_begin, pipeline.kit_begin, pipeline.kit_finish, pipeline.focus, leads.upsert, reconcile, digest` (écrit `data/reports/digest-<date>.md`, sans tag `mutator`), `request_approval` (crée une demande, notifie Jeremy).
- approve (2): `decide` (sans `approvalArg`: sans `approvalId` l'acteur est `agent` si la politique délègue, `CONTRACT.md:397-412`, un contrôle de forme casserait ce chemin légitime), `mark_sent` (`approvalArg: nonce`, Jeremy seul).
À faire dans la même PR: les AGENT.md des agents pipeline listent leurs `allow` write (le `tools:` y est « consultatif » aujourd'hui, `CONTRACT.md:458-462`); mise à jour du CONTRACT. Les lectures `jobkit_*` deviennent visibles à tout agent dès PR2 + migration, écritures jamais sans opt-in.

## 8. Risques et questions

Risques: (1) liste d'outils gonflée: 25 outils job kit visibles par agent; l'enregistrement après le wrapper de chargement différé (`index.ts` ~4300) devrait les rendre paresseux, à tester (je pense). (2) Mauvaise classification = écriture exposée: bornée par règle 3, opt-in par agent et `app validate`. (3) Identité: le handler connaît `callerSessionId`, pas le driver (`CONTRACT.md:397-399`): suivi, hors périmètre. (4) Clients à liste figée (§3). (5) Règle dupliquée CLI/démon: une seule fonction. (6) Le générateur de `DAEMON_TOOL_NAMES` ne doit pas capturer des tools d'app installées (je pense: `app_ui_*` est déjà dynamique, à confirmer en PR2). (7) Règle 1.6 transitoire: tant que PR2 n'est pas là, un tool exposé doit rester dans `ui.tools`.

Questions pour Jeremy:
1. Préfixe obligatoire et explicite (`jobkit`, `bureau`) ou dérivé de l'appId? Recommandation: obligatoire, courts, sans `_` (un défaut dérivé donnerait `job_application_kit_...`, 17+ car.).
2. Où l'agent opte-t-il pour l'écriture: AGENT.md par agent (versionné, auditable) ou liste globale dans la config du démon? Recommandation: AGENT.md par agent + coupe-circuit global `off|read|all` (défaut `read`).
3. `mcp-app` sans `exposes.tools`: garder l'ancien comportement avec avertissement, ou refuser? Recommandation: garder + avertir une version, puis refuser quand Bureau et job kit sont migrés; refuser tout de suite casserait les bundles de livres déjà distribués.
