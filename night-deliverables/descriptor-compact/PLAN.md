# T19 etape 1 — descripteur compact par defaut + pagination des gros champs du daemon

Livrable de PLAN uniquement. Aucune PR, aucun merge, aucun deploiement.
Base : `origin/main` = `a3075d4d` (branche `night/t19-descriptor-compact`).

---

## 1. Verification du retour brut, point par point

Chaque constat du retour analyse est re-verifie contre le code reel de ce clone.
La colonne "fichier:ligne" designe la ligne sur `origin/main` (`a3075d4d`).

| # | Constat du retour brut | Verdict | Preuve (fichier:ligne) |
|---|---|---|---|
| 1 | `agent_start` renvoie le descripteur brut, sans plafond | **VRAI** | `packages/runtime/src/agent-tools.ts:637-647` : le body est `{ ...result.descriptor, ... }` puis `JSON.stringify(body)`. Aucune projection, aucun `paginate()`, aucun `capResult`. Compare avec `session-tools.ts:957` (`publicSessionDescriptor`) qui, lui, retire `ptyResumeEnv` et `appendSystemPrompt`. |
| 2 | Le schema `agent-start-schema.ts` n'a pas de parametre `fields`, donc un `fields` envoye est ignore | **VRAI** | `packages/runtime/src/agent-start-schema.ts:104-558` : `agentStartInputShape` declare 58 cles, aucune `fields`/`full`/`limit`/`cursor`. Verifie a l'execution : `agentStartInputSchema.safeParse({ adapter:"hermes", fields:["id"], full:true })` -> succes, `parsed.data` = `{ adapter: "hermes" }` seulement (zod `strip` par defaut). |
| 3 | Plus gros champ : `availableCommands` | **VRAI mais INCOMPLET** | `availableCommands` est bien un gros champ : `packages/runtime/src/sessions.ts:2269` (type), `:7917` (mirror de l'evenement ACP `available-commands`). MAIS le plus gros champ du descripteur brut d'`agent_start` est `appendSystemPrompt` (mesure : 18 060 o sur l'AGENTS.md de ce repo) qui est **aussi** renvoye par `agent_start` (`sessions.ts:11191` pose le champ, `agent-tools.ts:638` le republie). Le retour brut ne le mentionne pas. Voir tableau de mesures §2. |
| 4 | Ensuite `mcpServers` (specs completes), `contextContinuity`, `availableModes` | **PARTIEL** | Les trois existent bien : `sessions.ts:2299` (`mcpServers: AcpMcpServer[]`), `sessions.ts:2528` (`contextContinuity`), `sessions.ts:2171` (`availableModes`). Mais leur poids reel est marginal : mesure `mcpServers` = 73 o, `contextContinuity` = 115 o, `availableModes` = 161 o. Ils ne sont pas des cibles de reduction de taille. Le vrai champ lourd a cote est `configOptions` (`:2188`, echo live des options ACP, 89 o dans le descripteur minimal mais non borne dans le schema) et `skills` / `sessionSkills`. |
| 5 | `harness_capabilities` renvoie toutes les capabilities de tous les adapters, sans plafond | **VRAI** | `packages/runtime/src/agent-tools.ts:1822-1867` : `server.tool("harness_capabilities", { adapter: z.string().optional() })`, sortie `JSON.stringify({ capabilities })`. Le filtre `adapter` existe deja (optionnel), mais il n'y a ni `limit`/`cursor`/`fields`/`full` ni projection. Mesure : 75 215 o pour 13 adapters installes sur cette box (dont `models` = 22 924 o pour opencode seul). |
| 6 | `capabilities_inventory` aussi gros, sans parametre | **VRAI** | `packages/runtime/src/session-tools.ts:3170-3184` : `server.tool("capabilities_inventory", {}, ...)` — schema d'entree **vide**, aucun `fields`/`limit`/`cursor`. Le corps est `computeCapabilitiesInventory(...)` serialise en entier. |
| 7 | Le map `reach` (21 harnesses) est repete pour chaque serveur MCP | **VRAI sur le principe, chiffre a corriger** | `packages/runtime/src/capabilities-inventory.ts:66` (`reach: Record<string, ImportedMcpReach>` sur **chaque** entree importee) + `:183-210` (`computeImportedReach` produit une entree par couple (import, adapter)). Le "21 harnesses" est un chiffre d'une autre machine : sur cette box `listInstalledAdapters()` renvoie **13** adapters importables (27 repertoires dans `adapters/`, 13 importables). Mesure : `reach` = 257 o par serveur MCP importe avec 13 adapters, contre 112 o sans le map. Le map est donc ~2,3x le poids de l'entree qu'il accompagne. |
| 8 | `skills.byHarness` liste tous les skills installes (~60 chez hermes) | **PARTIEL / chiffre invérifiable ici** | `packages/runtime/src/capabilities-inventory.ts:114-120` (`SkillsByHarnessEntry.installed` / `.native`) et `:438-460` (`buildHarnessEntry` -> `listInstalledForTarget` `:412` / `listNativeSkills` `:433`). Le contenu depend de `~/.hermes/skills` et `~/.claude/skills` de la machine, pas du repo. Sur cette box ces repertoires sont **vides** (0 skill) : le "~60" n'est pas reproductible ici. Ce qui est mesurable : le repo declare 30 skills dans `packages/skill-pack-agentproto/src/skills`, 2 dans `skill-pack-agentpush`, 10 dans `skill-pack-bureau` — soit 42 skills d'inventaire pack, et `byHarness` est repete par adapter. |
| 9 | Aucun plafond sur les tools bruts : le cap de 100 Ko n'existe que pour les tools enregistres via la couche contrat (`to-mcp-tool.ts` ~271) | **VRAI** | `packages/mcp-server/src/to-mcp-tool.ts:262` (`MCP_RESULT_MAX_BYTES = 100_000`), `:271` (`capResult`), `:251` (appel unique, dans le `handler` de `toMcpTool`). `toMcpTool` n'est appele que par `registerBuiltinTool` (`packages/mcp-server/src/register-builtin-tool.ts:60`) et `app-mcp-server.ts:94`. Or les outils concernes sont enregistres en `server.tool(...)` direct : `agent_start` (`agent-tools.ts:399`, `server.registerTool`), `harness_capabilities` (`agent-tools.ts:1822`), `capabilities_inventory` (`session-tools.ts:3170`). Bilan : dans `packages/runtime/src` (hors tests), **271** enregistrements en direct (`server.tool(` = 265 + `server.registerTool(` = 6, dont `agent_start`) contre **46** en `registerBuiltinTool` — la majorite des outils du daemon **contourne** le cap. |
| 10 | Doublons : `paginated` recopie dans 4 fichiers | **VRAI mais mal decrit** | Ce ne sont pas 4 copies de `paginated` mais 4 copies d'un helper local nomme `paginatedLegacyList` : `packages/runtime/src/app-tools.ts:107`, `task-tools.ts:61`, `app-data.ts:81`, `app-external.ts:53` (meme corps, ~25 lignes, `name: "paginatedLegacyList"`). Le `paginated()` canonique est dans `packages/tool/src/transformers.ts:78`; `session-tools.ts:1404` a son propre `registerPaginatedListTool` (local a `registerSessionTools`, non exporte). |
| 11 | Bon modele a copier : `compactSessionItem` porte `modelCount` | **FAUX** | `packages/runtime/src/session-tools.ts:964` `compactSessionItem` ne porte **pas** `modelCount` (il porte `model: string`). Le `modelCount` est sur la projection compacte d'`adapter_list` : `packages/runtime/src/agent-tools.ts:1728` (`modelCount: a.models?.length ?? 0`). Le reste du constat est juste : `full:true` sert d'echappatoire (`packages/tool/src/envelope.ts:114`), `adapter_models` pagine par id (`packages/runtime/src/agent-tools.ts:1789-1818`, `keyOf` a `:1814`). |
| 12 | `harness_capabilities` n'a pas eu ce traitement | **VRAI** | `agent-tools.ts:1822` : pas de `pageParamsShape`, pas de `project`, pas de `fields`. Seule la projection compacte existe pour `adapter_list` (`agent-tools.ts:1740`) et `adapter_models` (`:1789`). |
| 13 | Etape 7 du plan propose : "meme projection pour agent_prompt, session_restart, continue_fresh, adopt" | **FAUX pour 3 des 4** | `agent_prompt` (`agent-tools.ts:787`, `:949`) renvoie `{ ok, pending, delivery, sessionId, queued }` — deja petit, **pas** de descripteur. `session_continue_fresh` (`session-tools.ts:2690-2695`) renvoie `{ continuedFrom, continuedTo, checkpointId, checkpointPath, handoff }` — deja petit. `session_adopt` (`packages/runtime/src/lineage-tools.ts:108-118`) renvoie `{ ok, from, to, adopted, skipped }` — deja petit. Seul `session_restart` renvoie un descripteur (`session-tools.ts:5510`, `:5708`, `:5793`). |
| 14 | Etape 2 du plan propose : "availableCommands -> availableCommandsCount + commandsRef" | **VRAI comme direction, fausse comme unique action** | Le champ est un tableau d'objets `{ name, description?, input?, _meta? }` (`sessions.ts:2269-2275`), remplace **wholesale** a chaque notification ACP (`sessions.ts:7917`). Une projection par identite (`name` + `description`) suffit pour l'usage VS Code (`packages/vscode/src/webview/transcriptPanel.ts:2830-2834` lit `name`, `description`, `_meta.scope`). |
| 15 | Le retour brut ne dit rien de `session_capabilities` | **Ajout : `session_capabilities` est un deuxieme gros repondeur** | `packages/runtime/src/session-tools.ts:2359` + `packages/runtime/src/session-capabilities.ts:134` (`buildSessionCapabilities`) : la reponse inclut `commands` (projection complete de `availableCommands`, `session-capabilities.ts:160`) et `mcpServers` (avec `tools` + `toolCount` quand le mount est vivant, `session-capabilities.ts:193-196`). Mesure : 10 346 o pour 60 commandes. |

### Corriges apportes au plan propose

1. Le budget de reduction ne porte pas sur `mcpServers` / `contextContinuity` / `availableModes` (margaux) mais sur `appendSystemPrompt` + `availableCommands` + `configOptions`.
2. `agent_prompt`, `session_continue_fresh` et `session_adopt` sont **deja** compacts : ils sortent du perimetre.
3. `session_capabilities` entre dans le perimetre (10 Ko), `session_restart` reste dedans (descripteur brut via `publicSessionDescriptor`).
4. `compactSessionItem` n'est pas le bon modele de reference pour le descripteur de `agent_start` (c'est une projection de LISTE, sans `modelCount`) ; le bon modele est la projection compacte d'`adapter_list` (`agent-tools.ts:1728`) + `adapter_models` pagine (`:1789`).
5. Le "21 harnesses" devient "N adapters installes" (13 ici) ; la mesure doit etre parametrable.
6. Le dedup des 4 fichiers porte sur `paginatedLegacyList`, pas sur `paginated` ; et `registerPaginatedListTool` (session-tools.ts:1404) est aujourd'hui local a `registerSessionTools` : le "helper partage" n'existe pas encore, il faut d'abord l'extraire.

---

## 2. Mesures AVANT

### 2.1 Methode exacte (reproductible)

La box n'a **pas** de daemon vivant. Les mesures sont donc faites **par execution du code reel du repo**, sans daemon : on importe les modules source via `vite-node` (pas de build de `.d.ts`, pas de daemon), on fabrique un descripteur avec la **vraie** fonction de construction (`SessionsRegistry.spawnAgent`, `packages/runtime/src/sessions.ts:11124`), on sérialise avec `JSON.stringify` et on compte les octets UTF-8.

Reproduction :

```sh
cd /home/user/agentproto
pnpm install --filter "@agentproto/runtime..." --filter "@agentproto/tool..." --filter "@agentproto/cli..."
cd packages/runtime
cat > /tmp/t19-measure.ts <<'EOF'
import { readFileSync } from "node:fs"
import { createSessionsRegistry } from "./src/sessions.js"
import { compactSessionItem } from "./src/session-tools.js"
import { buildSessionCapabilities } from "./src/session-capabilities.js"
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v ?? null), "utf8")
const registry = createSessionsRegistry({ persist: false })
const AGENTS_MD = readFileSync("/home/user/agentproto/AGENTS.md", "utf8")
const commands = Array.from({ length: 60 }, (_, i) => ({
  name: `/skill-${i}`,
  description: `Skill ${i} description lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor`,
  input: { hint: `/skill-${i} [args]` },
}))
const desc = registry.spawnAgent({
  workspaceSlug: "default", cwd: "/tmp",
  agentSession: { sessionId: "s1", pid: 1, steer: async () => {}, prompt: async () => {} } as never,
  adapterSlug: "hermes", label: "demo", model: "gpt-5",
  skills: Array.from({ length: 12 }, (_, i) => `ap-skill-${i}`),
  mcpServers: [{ name: "daemon", transport: "http", ref: "http://127.0.0.1:18790/mcp" }],
  appendSystemPrompt: AGENTS_MD,
  contextContinuity: { mode: "auto", warnAtPct: 70, compactAtPct: 80, continueFreshAtPct: 90, hardStopAtPct: 95, goal: true, plan: true },
})
const wide = { ...desc, availableCommands: commands } as never
console.log("A. agent_start body (descripteur BRUT) =", bytes(wide))
console.log("   appendSystemPrompt(AGENTS.md repo) =", bytes(AGENTS_MD))
console.log("   availableCommands (60 cmd) =", bytes(commands))
const { appendSystemPrompt: _x, ptyResumeEnv: _y, ...pub } = wide as Record<string, unknown>
console.log("B. publicSessionDescriptor (session_* tools) =", bytes(pub))
console.log("C. compactSessionItem =", bytes(compactSessionItem(wide as never)))
console.log("D. session_capabilities =", bytes(buildSessionCapabilities(wide as never, 0)))
EOF
cp /tmp/t19-measure.ts ./t19-measure.ts
./node_modules/.bin/vite-node t19-measure.ts ; rm -f t19-measure.ts
```

Pour `harness_capabilities` et le map `reach` :

```sh
cd packages/cli
cat > t19-cap.ts <<'EOF'
import { listHarnessCapabilities } from "./src/registry/resolve.js"
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v ?? null), "utf8")
const caps = await listHarnessCapabilities() as Array<Record<string, unknown>>
console.log("adapters:", caps.length, "total:", bytes(caps))
for (const c of caps) console.log("  ", c.adapter, bytes(c))
EOF
cp t19-cap.ts ./t19-cap.ts && ../runtime/node_modules/.bin/vite-node t19-cap.ts ; rm -f t19-cap.ts
```

```sh
cd packages/runtime
cat > t19-reach.ts <<'EOF'
import { computeImportedReach } from "./src/capabilities-inventory.js"
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v ?? null), "utf8")
const slugs = ["antigravity","claude-code","claude-code-cloud","claude-sdk","codex","gemini","grok-cli","hermes","mastracode","mastracode-inprocess","openclaw","opencode","pi"]
const adapters = slugs.map(slug => ({ slug, name: slug, version: "0.0.0", description: "", protocol: "acp", streaming: true, packageName: `@agentproto/adapter-${slug}`, modes: [] }))
const reach = computeImportedReach(["imp-1"], adapters as never, {} as never, { version: 1, bundles: [] } as never)
console.log("reach (13 adapters):", bytes(reach.get("imp-1")))
EOF
cp t19-reach.ts ./t19-reach.ts && ./node_modules/.bin/vite-node t19-reach.ts ; rm -f t19-reach.ts
```

### 2.2 Chiffres

**Perimetre `agent_start` (descripteur brut, session hermes, AGENTS.md du repo, 60 slash-commands) — MESURE :**

| Element | Octets | Statut |
|---|---|---|
| `agent_start` body complet (descripteur brut + output) | **29 217** | MESURE |
| dont `appendSystemPrompt` (= AGENTS.md 17 714 o + enrobage) | **18 060** | MESURE |
| dont `availableCommands` (60 entrees) | **10 231** | MESURE |
| dont `contextContinuity` | 115 | MESURE |
| dont `mcpServers` (1 mount http) | 73 | MESURE |
| dont `availableModes` (3 modes) | 161 | MESURE |
| dont `configOptions` (1 option, 1 valeur) | 89 | MESURE |
| descripteur minimal + 4 commandes + 3 modes + 1 configOption | 796 | MESURE |
| dont `skills` (12 ids) | 159 | MESURE |
| descripteur **minimal** (spawn nu, aucun gros champ) | 491 | MESURE |

**Tools voisins — MESURE :**

| Reponse | Octets | Source |
|---|---|---|
| `publicSessionDescriptor` (ce que renvoie `session_restart`, `session_archive`, `session_rename`, `session_unarchive`, `session_flag_status`, `session_set_keepalive`, `session_set_pinned`, `session_reorder_pinned`) | **11 135** | `session-tools.ts:957` |
| `session_capabilities` (`buildSessionCapabilities`, 60 commandes) | **10 346** | `session-capabilities.ts:134` |
| `compactSessionItem` (projection de reference, meme descripteur) | 203 | `session-tools.ts:964` |

**`harness_capabilities` (13 adapters installes sur cette box) — MESURE :**

| Element | Octets |
|---|---|
| total | **75 215** |
| opencode | 24 044 (dont `models` 22 924) |
| pi | 21 448 (dont `models` 20 404) |
| mastracode | 21 044 (dont `models` 20 136) |
| claude-sdk / claude-code / codex / mastracode-inprocess | 2 248 / 2 101 / 1 145 / 986 |
| grok-cli / gemini / hermes / openclaw / claude-code-cloud / antigravity | 522 / 482 / 353 / 349 / 248 / 231 |

Le champ `models` represente 63 % du poids total (47 464 o sur 75 215 o).

**`capabilities_inventory` — MESURE (composants, sur 13 adapters) :**

| Element | Octets |
|---|---|
| `reach` d'un serveur MCP importe (map 13 adapters) | **257** |
| la meme entree importee **sans** le map `reach` | 112 |
| entree importee complete avec `reach` | 378 |
| `skills.byHarness` (13 adapters x 6 skills, forme exacte `SkillsByHarnessEntry`) | 2 468 |

Autrement dit : sur un daemon avec `I` imports et `N` adapters, le map `reach` ajoute `~257 x I` octets (13 adapters) et se repete `I` fois.

### 2.3 Ce qui est mesure vs ce qui est estime

**MESURE (executed sur ce clone, chiffres reproductibles par les scripts ci-dessus) :**
- toutes les tailles de `agent_start` / `publicSessionDescriptor` / `session_capabilities` / `compactSessionItem` ;
- la taille totale de `harness_capabilities` et son decoupage par adapter ;
- le poids du map `reach` par serveur MCP importe ;
- le poids de `skills.byHarness` sur la forme exacte du type ;
- le fait que `agent_start` a 58 cles de schema et **aucune** `fields` ;
- le fait que `capabilities_inventory` a un schema d'entree vide.

**ESTIME / NON REPRODUCTIBLE ICI (a signaler comme tel) :**
- le "~60 skills chez hermes" : depend de `~/.hermes/skills` sur la machine, vide ici. Le repo en declare 42 (30 + 2 + 10). Le comportement du code est verifie, le nombre ne l'est pas.
- le "21 harnesses" : le nombre d'adapters **installes** est une donnee de la machine ; 13 ici. Le code produit une entree par adapter installe (`capabilities-inventory.ts:183-210`) — la formule est verifiee, le 21 ne l'est pas.
- le "cap de 100 Ko" qui ne s'applique pas aux tools bruts : verifie **par lecture du code** (un seul point d'appel de `capResult`, `to-mcp-tool.ts:251`, atteignable seulement via `toMcpTool`), pas par un appel daemon reel.
- l'absence de `fields` sur `agent_start` : verifie a l'execution par `safeParse` (les cles inconnues sont retirees par zod), mais **pas** par un appel MCP reel.

**Non mesure (hors perimetre de cette etape) :** la taille reelle d'un `availableCommands` de production (depend du harness : nombre de skills du harness + slash-commands). Le scenario "60 entrees x ~170 o" est un **scenario**, pas une observation. L'echelle est correcte (hermes expose ses skills comme commandes), le chiffre exact depend de l'installation.

---

## 3. Perimetre

### Traites (dans le plan)

| Tool | Surface | Etat actuel |
|---|---|---|
| `agent_start` | MCP | descripteur brut, 29 217 o |
| `session_restart` | MCP | `publicSessionDescriptor`, 11 135 o |
| `session_archive`, `session_unarchive`, `session_flag_status`, `session_rename`, `session_set_keepalive`, `session_set_pinned`, `session_reorder_pinned` | MCP | `publicSessionDescriptor`, 11 135 o |
| `session_capabilities` | MCP + `GET /sessions/:id/capabilities` | 10 346 o |
| `harness_capabilities` | MCP | 75 215 o, 13 adapters |
| `capabilities_inventory` | MCP + `GET /capabilities/inventory` | schema d'entree vide |
| `session_list` | MCP + `GET /sessions` | deja compact (`compactSessionItem`), `full:true` pour le brut — **reference**, pas cible |

### Hors perimetre (et pourquoi)

| Item | Raison |
|---|---|
| `agent_prompt`, `agent_continue_fresh`/`session_continue_fresh`, `session_adopt` | Repondent deja par un objet plat de quelques champs. Aucun descripteur. Rien a compacter. |
| `session_output` / `agent_output` | Retourne du texte de ring buffer, borne par `lastN` (max 500 lignes). |
| `adapter_list`, `adapter_models` | **Le modele a copier**, pas une cible : deja compacts + `full:true` + pagination par id. |
| `session_list` / `GET /sessions` | deja `compactSessionItem` par defaut ; `?fields=` existe deja sur HTTP (`http-server.ts:363-372`). |
| `catalog_models`, `bundle_list`, `mcp_discovered_list`, `mcp_imported_list`, `skill_imported_list`, `session_queue_list`, `worktree_status` | deja migres sur `registerPaginatedListTool` (`session-tools.ts:3112`, `:3137`, `:3305`, `:3533`, `:3635`, `:4052`, `:4337`). |
| `terminal_start` | Renvoie `publicSessionDescriptor` (`session-tools.ts:7670`) — candidat de la meme PR que `session_restart`, a confirmer. |
| Le daemon en production (deploiement, publication) | Hors tache. |

---

## 4. Decoupage en PR atomiques

Regle commune a toutes les PR : **aucun changement de forme de reponse sans interrupteur explicite**, et un test de budget de taille qui echoue sur le code actuel.

---

### PR 1 — `agent_start` : descripteur compact par defaut + `full`/`fields`

**Portee**
- `packages/runtime/src/agent-start-schema.ts` : ajouter `full: z.boolean().optional()` et `fields: z.array(z.string()).optional()` a `agentStartInputShape` (les 2 sont **absents** aujourd'hui, verifie).
- `packages/runtime/src/agent-tools.ts:637-647` : passer le descripteur par une projection compacte (nouvelle fonction exportee `compactAgentStartDescriptor`, a cote de `compactSessionItem` dans `session-tools.ts:964`).
- Projection compacte retenue : identite/routage + compteurs, plus `availableCommandsCount`, `availableModesCount`, `mcpServerCount`, `skillsCount`. Les tableaux eux-memes (`availableCommands`, `availableModes`, `configOptions`, `mcpServers` complets) sortent du defaut.
- `full: true` restitue le descripteur brut actuel (echappatoire, comme `session_list`).
- `fields: [...]` applique un allowlist par champ (comme `?fields=` HTTP, `http-server.ts:363`).

**Regle de compatibilite**
- `full` absent + `fields` absent => **compact**. C'est un changement de forme de reponse : les clients qui lisent `descriptor.availableCommands` sur la reponse d'`agent_start` cassent.
- Mitigation : la forme brute actuelle reste disponible via `full:true`, et `tool_help` documente le basculement.
- Compatibilite client audit : VS Code lit le descripteur via `GET /sessions/:id` (`packages/vscode/src/client/daemonClient.ts:376`) et via `session_list`, **pas** via la reponse d'`agent_start`. Le CLI non plus (`packages/cli/src/commands/sessions.ts`). `packages/harness/src/client.ts:77` (`HarnessClient.start`) renvoie le descripteur a ses appelants (worktree) : a verifier champ par champ avant merge.
- `appendSystemPrompt` : le descripteur brut **le contient** et le republie aujourd'hui (`sessions.ts:11191` + `agent-tools.ts:638`). Le retirer du defaut est un gain de 18 Ko dans le cas AGENTS.md. `publicSessionDescriptor` (`session-tools.ts:957`) le retire deja pour les autres tools : meme traitement pour `agent_start` = coherence, et fin d'une fuite de contenu systeme vers le client.

**Tests a ajouter**
- `packages/runtime/src/__tests__/agent-start-compact.test.ts` :
  - la reponse par defaut ne contient ni `availableCommands` ni `availableModes` ni `configOptions` ni `appendSystemPrompt` ;
  - la reponse par defaut contient `availableCommandsCount` egal au nombre reel ;
  - `full:true` restitue exactement la forme actuelle (comparaison champ par champ sur un descripteur de reference) ;
  - `fields:["id","model"]` ne renvoie que ces champs.
- `packages/runtime/src/__tests__/agent-start-size-budget.test.ts` : budget d'octets sur le corps de la reponse (seuil = valeur actuelle - cible, cf. §5).
- Test de non-regression `packages/harness` : `HarnessClient.start` doit continuer a trouver `id` et `status` dans la reponse compacte.

**Risque**
- Moyen. Le plus gros risque est un client externe (hors repo) qui lit `availableCommands` dans la reponse d'`agent_start`. Le grep du repo ne trouve aucun lecteur de ce genre : VS Code passe par `GET /sessions/:id`, le CLI par `sessions.ts`.

**Critere de sortie mesurable**
- Corps de la reponse `agent_start` (cas de reference : 60 commandes + AGENTS.md du repo) : **29 217 o -> <= 1 500 o**.
- `full:true` : taille inchangee vs avant (29 217 o) — aucune regression de forme.
- `pnpm --filter @agentproto/runtime test` et `pnpm --filter @agentproto/runtime check-types` verts.

---

### PR 2 — Pagination de `availableCommands` : nouveau tool `session_commands`

**Portee**
- Nouveau tool MCP `session_commands` dans `packages/runtime/src/session-tools.ts`, enregistre via `registerPaginatedListTool` (`session-tools.ts:1404`), avec `limit`/`cursor`/`fields`/`full` herites de `pageParamsShape` (`packages/tool/src/envelope.ts:104`) et un filtre `name` (prefixe) + `scope`.
- Row shape : `{ name, description?, hint?, scope? }` — c'est exactement ce que VS Code lit aujourd'hui (`packages/vscode/src/webview/transcriptPanel.ts:2830-2834`).
- `keyOf` = `name` (stable, comme `adapter_models` par id).
- Enregistrer le nom du tool dans `packages/runtime/src/daemon-tool-names.generated.ts` (genere par `pnpm --filter @agentproto/runtime gen:daemon-tool-names`).

**Dependance** : PR 1 (la projection compacte renvoie `availableCommandsCount` + un `commandsRef` qui pointe sur ce tool). PR 1 et PR 2 peuventfusionner, mais l'ordre PR1 -> PR2 garde chaque commit testable.

**Compatibilite**
- Ajout pur (nouveau tool), aucune suppression. `session_capabilities` garde sa forme actuelle jusqu'a PR 3.
- Le tool doit etre accessible par le client VS Code : `packages/vscode/src/client/daemonClient.ts` ajoute une methode `sessionCommands(sessionId, opts)`. C'est un ajout, pas une rupture.

**Tests**
- Pagination : `limit`/`cursor` parcourt les 60 commandes sans doublon ni trou.
- Filtre `name` : prefixe `/sk` ne renvoie que les commandes concernees.
- Budget : une page de 200 commandes tient sous 25 Ko.

**Risque** : faible. Nom de tool a reserver dans `DAEMON_TOOL_NAMES` (controle `agentproto app validate`).

**Critere de sortie mesurable**
- `session_capabilities` et `session_list` n'ont plus a transporter la liste ; la liste est accessible page par page.
- Recuperer 60 commandes par 1 appel de `limit:100` : reponse < 12 Ko (mesure actuelle d'une liste de 60 : 10 231 o en JSON brut, moins les champs non retenus).

---

### PR 3 — `session_capabilities` : version compacte + pagination des commandes

**Portee**
- `packages/runtime/src/session-capabilities.ts:134` : `buildSessionCapabilities` accepte une option `commands: "full" | "compact" | "none"`.
- Par defaut : `commands: []` + `commandsCount: N` (la liste part dans `session_commands`, PR 2).
- `session_capabilities` accepte `full:true` pour la forme actuelle.
- `packages/runtime/src/session-tools.ts:2359` : idem cote schema du tool.
- Jumeau HTTP `GET /sessions/:id/capabilities` (`http-server.ts:8439`) : meme comportement, meme builder.

**Compatibilite**
- `session_capabilities` est consomme par `packages/vscode/src/client/types.ts` et par les vues Capabilities. Le champ `commands` est lu par le panel de transcript ? Verifier : `transcriptPanel.ts:2830` lit `session.availableCommands` (le descripteur), **pas** `capabilities.commands`. A confirmer PR par PR.
- Un client externe qui lit `capabilities.commands[]` casse. Echappatoire `full:true`.

**Tests**
- `capabilities.commands` vide par defaut, `capabilities.commandsCount` = N.
- `full:true` restitue les 60 commandes.
- La reponse par defaut < 2 Ko (mesure actuelle 10 346 o).

**Risque** : moyen (surface publique lue par des clients tiers).

**Critere de sortie mesurable**
- `session_capabilities` : **10 346 o -> <= 2 000 o**.

---

### PR 4 — `session_restart` et les tools `publicSessionDescriptor` : projection compacte

**Portee**
- `packages/runtime/src/session-tools.ts:957` (`publicSessionDescriptor`) : ne suffit plus. Introduire `compactPublicDescriptor` (identite/routage + compteurs) et l'utiliser sur les tools qui renvoient aujourd'hui le descripteur brut : `session_restart` (`:5510`, `:5708`, `:5793`), `session_archive` (`:5873`), `session_unarchive` (`:6603`), `session_flag_status` (`:6735`), `session_rename` (`:6845`), `session_set_keepalive` (`:6925`), `session_set_pinned` (`:7159`), `session_reorder_pinned` (`:7242`, tableau de descripteurs), `terminal_start` (`:7670`).
- `full:true` par tool (meme schema `pageParamsShape` partage).

**Compatibilite**
- Ces tools renvoient aujourd'hui le descripteur brut. Les clients VS Code / CLI lisent-ils des champs speciaux ? `session_rename` renvoie le descripteur renomme : le nom doit rester lisible (donc `name`/`label`/`title` restent dans la projection).
- Verification pre-PR : grep des champs lus sur ces reponses dans `packages/vscode/src` et `packages/cli/src`.

**Tests**
- Chaque tool : la reponse par defaut ne contient plus `availableCommands`/`availableModes`/`configOptions`/`appendSystemPrompt`.
- `full:true` : forme inchangee.
- `session_rename` : `name`/`label` toujours presents.

**Risque** : moyen.

**Critere de sortie mesurable**
- `session_restart` (et congeneres) : **11 135 o -> <= 1 500 o**.

---

### PR 5 — `harness_capabilities` : pagination + projection

**Portee**
- `packages/runtime/src/agent-tools.ts:1822-1867` : migrer vers `registerBuiltinTool` + `paginated()` (`packages/tool/src/transformers.ts:78`), comme `adapter_list` (`:1740`).
- Row shape compacte : `{ adapter, source, discoverable, providerCount, modelCount, authStoreCount }` — l'equivalent de `modelCount` de `adapter_list` (`agent-tools.ts:1728`).
- `full:true` sur un adapter donne la fiche complete (providers/models/authStores) — le detail que VS Code affiche deja (`packages/vscode/src/client/types.ts:1468`).
- Le `filter adapter` existant est conserve ; ajouter `limit`/`cursor`.

**Compatibilite**
- `packages/vscode/src/client/daemonClient.ts:1226-1234` (`harnessCapabilities()`) appelle le tool et lit `capabilities`. Si la forme par defaut change, ce client casse. **PR obligatoirement couplee avec la mise a jour du client VS Code** dans la meme PR (ou la forme par defaut reste identique et seule la pagination est ajoutee — a trancher, cf. §6 decision 2).

**Tests**
- Page de 5 adapters < 8 Ko.
- `full:true` sur `opencode` restitue `models` complet (22 924 o sur cette box — c'est le but).
- Le client VS Code continue de fonctionner (test `daemonClient.test.ts` a adapter).

**Risque** : moyen (client VS Code dans le repo).

**Critere de sortie mesurable**
- `harness_capabilities` par defaut : **75 215 o -> <= 10 000 o** (13 adapters).
- La fiche complete d'un adapter reste accessible en 1 appel `full:true`.

---

### PR 6 — `capabilities_inventory` : parametres + factorisation du map `reach`

**Portee**
- `packages/runtime/src/session-tools.ts:3170` : le schema d'entree passe de `{}` a un objet avec `fields`, `limit`, `cursor`, `adapter`.
- `packages/runtime/src/capabilities-inventory.ts:66` : le map `reach` par serveur MCP importe est un candidat a la factorisation : soit `reach` complet (defaut, retro-compatible), soit `reach` restreint a un adapter (`?adapter=`) — cf. §6 decision 3.
- `skills.byHarness` : option `skills: "none" | "counts" | "full"` (defaut `counts` : `{ adapter, installedCount, nativeCount, spawnOption }`).

**Compatibilite**
- `packages/vscode/src/client/types.ts:1667-1700` (`reach` a `:1679`) lit `reach` par import et `byHarness[].installed[]`. Un changement de forme casse le panneau Capabilities. Couplee dans la meme PR.

**Tests**
- `fields:["mcp.imported"]` ne renvoie pas le bloc skills.
- `adapter:"hermes"` restreint `reach`.
- Budget : la reponse par defaut < 15 Ko avec 13 adapters et 3 imports.

**Risque** : moyen (client VS Code).

**Critere de sortie mesurable**
- `capabilities_inventory` par defaut : contribution du map `reach` de **257 o x N imports** a **<= 60 o x N imports**, ou un `reach` par adapter. Chiffre a fixer apres decision 3.

---

### PR 7 — Extraction du helper de pagination partage + suppression des 4 copies

**Portee**
- Extraire `paginatedLegacyList` (4 copies : `app-tools.ts:107`, `task-tools.ts:61`, `app-data.ts:81`, `app-external.ts:53`) dans un module partage (proposition : `packages/tool/src/legacy-list.ts` ou `packages/runtime/src/paginated-legacy-list.ts`), re-exporte par `packages/tool/src/index.ts`.
- Extraire `registerPaginatedListTool` (`session-tools.ts:1404`) hors de `registerSessionTools` pour etre utilisable par `agent-tools.ts` et `app-*.ts`.
- Supprimer les 4 copies locales.

**Compatibilite**
- Interne. Le comportement de chaque tool doit rester **byte-identique** : golden test sur la forme de sortie de `app_list`, `task_list`, `app_data`, `app_external` avant/apres.

**Tests**
- Golden tests : la sortie des 4 tools (forme `{ [itemKey]: rows }`, page `{ items, nextCursor, total }`, projection `compact`) est identique a l'existant.
- Un test verifie qu'il ne reste qu'une definition de `paginatedLegacyList` dans l'arbre (grep-based, comme `daemon-tool-names.test.ts` le fait deja).

**Risque** : faible (refactor interne), mais le golden test est indispensable.

**Critere de sortie mesurable**
- 4 occurrences de `function paginatedLegacyList` -> 1.
- 0 changement d'octet sur les 4 tools (golden).

---

### PR 8 — Tests de budget de taille transverses

**Portee**
- `packages/runtime/src/__tests__/response-size-budget.test.ts` : un test qui mesure la taille de la reponse de chaque tool touche par les PR 1-6 et echoue si elle depasse le seuil.
- Les seuils sont chiffres, derives des mesures §2 (avant) et des cibles §5 (apres).
- Le test est **rouge** sur le code actuel (c'est l'exigence de la tache) : il faut donc l'introduire **avec** chaque PR qui reduit la taille, sinon le gate du repo casse. Point de vigilance : `pnpm test` doit rester vert en fin de chaque PR.

**Risque** : faible.

**Critere de sortie mesurable**
- Suite verte, seuils documentes dans le test, et une ligne de commentaire par seuil qui donne la mesure "avant" correspondante.

---

## 5. Criteres de sortie agreges (avant / apres)

| Surface | Avant (mesure) | Cible apres | Reduction |
|---|---|---|---|
| `agent_start` (60 cmd + AGENTS.md) | 29 217 o | <= 1 500 o | **-95 %** |
| `agent_start` (`full:true`) | 29 217 o | 29 217 o (identique) | 0 (echappatoire) |
| `session_restart` et congeneres | 11 135 o | <= 1 500 o | -87 % |
| `session_capabilities` | 10 346 o | <= 2 000 o | -81 % |
| `harness_capabilities` (13 adapters) | 75 215 o | <= 10 000 o | -87 % |
| `capabilities_inventory` — bloc `reach` | 257 o x N imports | <= 60 o x N imports (ou par adapter) | -77 % (ou -100 % de la repetition) |
| `session_commands` (nouveau) | n/a | 60 commandes en 1 page < 12 Ko | - |
| Copies de `paginatedLegacyList` | 4 | 1 | -75 % |

Les cibles sont des **seuils de test** a passer au gate, pas des promesses de gain : elles sont dimensionnees pour que le budget par tool reste sous 25 Ko (largement sous le cap de 100 Ko de la couche contrat, `to-mcp-tool.ts:262`), avec de la marge pour les cas nominaux plus gros.

---

## 6. Trois decisions a trancher

### Decision 1 — `agent_start` : changement de forme par defaut, ou ajoute ad-hoc ?

**Question** : `agent_start` renvoie-t-il un descripteur **compact par defaut** (rupture de forme, `full:true` pour l'ancien), ou garde-t-il la forme brute et ajoute-t-il seulement `fields`/`limit` optionnels (compatible, mais le poids par defaut ne baisse pas) ?

**Enjeu** : c'est la seule decision qui atteint la cible de -95 %. `fields` seul ne reduit rien si le client ne le passe pas.

**Recommandation** : compact par defaut + `full:true`. Le repo a deja le precedent (`session_list` est compact par defaut avec `full:true`, `session-tools.ts:1459`+ (`pageParamsShape`) ; `adapter_list` idem, `agent-tools.ts:1740`), et le grep confirme qu'aucun client du repo lit `availableCommands` dans la reponse d'`agent_start`. Le point de vigilance est le client **externe** : le PLAN documente la rupture et le mecanisme d'echappatoire.

### Decision 2 — `harness_capabilities` : la forme par defaut change-t-elle ?

**Question** : migration vers `registerBuiltinTool` + `paginated()` avec une **nouvelle** projection compacte par defaut (le client VS Code `harnessCapabilities()` doit etre adapte dans la meme PR), ou simple ajout de `limit`/`cursor`/`fields` en gardant la forme actuelle par defaut (compatible, mais 75 Ko restent la regle) ?

**Enjeu** : 63 % du poids est dans `models` (47 464 o). Sans projection par defaut, le tool reste un repondeur de 75 Ko.

**Recommandation** : projection compacte par defaut + `full:true` pour la fiche complete, **avec** la mise a jour du client VS Code dans la meme PR (le client est dans le repo, donc pas de rupture externe). Le prefixe `adapter` deja present permet de recuperer la fiche d'un adapter precis.

### Decision 3 — `capabilities_inventory` : le map `reach` est-il factorise, restreint, ou inchange ?

**Question** : le map `reach` (257 o par serveur MCP importe, repete pour chaque serveur) doit-il (a) rester tel quel, (b) etre restreint a un adapter via un parametre `adapter`, (c) etre factorise hors du tableau (un bloc `reachByAdapter` unique plutot qu'une copie par serveur) ?

**Enjeu** : (c) est la vraie correction structurelle — le map ne depend que de (adapter, bundle, import), donc `N imports x N adapters` entrees se reduisent a `N adapters` entrees. (b) est un pansement : le client doit alors appeler le tool une fois par adapter. (a) ne reduit rien.

**Recommandation** : (c), avec `reach` conserve par defaut sous sa forme actuelle pour compatibilite (`reach` par import, calcule a partir du bloc factorise) tant que le client VS Code n'est pas migre, puis migration du client vers le bloc factorise. Mais cela ajoute une forme de reponse : arbitrairement entre "un bloc de plus" et "une forme nouvelle", ce qui a un cout de migration cote VS Code.

---

## 7. Ce que ce plan ne couvre pas

- `agent_prompt`, `session_continue_fresh`, `session_adopt` : **verifies et hors perimetre** — ils renvoient deja des objets plats de quelques champs (`agent-tools.ts:787`, `session-tools.ts:2690`, `lineage-tools.ts:109`). Le retour brut les listait a tort parmi les cibles.
- `session_continue_fresh` (le tool, pas l'agent) : verifie, reponse de 5 champs, hors perimetre.
- Le comportement de `available_commands_update` cote harness (qui decide combien de commandes sont annoncees) : hors perimetre. Le plan traite la **consommation** de la liste, pas sa production.
- Le nombre reel de commandes d'un harness en production : non mesure ici (scenario a 60 entrees).
- Le stock de skills par machine (`~/.hermes/skills`, `~/.claude/skills`) : non reproductible sur cette box.
- `terminal_start` (`session-tools.ts:7670`) : candidat de PR 4, a confirmer (il renvoie `publicSessionDescriptor`).
- Le cap global de 100 Ko sur tous les `server.tool` bruts : **propose dans le retour brut (etape 9), non repris ici** — c'est un changement de comportement global sur 265 outils, avec un fort risque de casser des clients qui attendent une reponse complete sans pagination. A traiter comme une PR separee, apres les PR 1-6, et seulement si les seuils par tool (PR 8) ne suffisent pas. Non mesure : le comportement actuel d'un tool brut au-dela de 100 Ko n'a pas ete observe sur un daemon reel.
- Les outils enregistres via la couche contrat (46 `registerBuiltinTool`) : deja capes a 100 Ko (`to-mcp-tool.ts:262`), donc hors perimetre de la reduction, mais dans le perimetre de la **coherence** (leur `paginate`/`fields` existent deja).
- Aucun deploiement, aucune publication, aucune PR : le livrable de cette tache est ce document.
