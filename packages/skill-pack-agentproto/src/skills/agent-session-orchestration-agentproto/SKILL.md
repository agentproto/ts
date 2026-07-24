---
name: agent-session-orchestration-agentproto
description:
  "Piloter et SUPERVISER d'autres agents de code (claude-code, hermes, …) via le
  daemon agentproto depuis une session cowork : lancer des sessions, babysitter
  un agent débutant pas-à-pas, exporter une conversation d'agent en markdown
  lisible, reprendre (resume) une session avec son contexte, et orchestrer
  plusieurs agents en parallèle (launch-and-leave). Déclenche ce skill quand
  l'utilisateur veut « lancer un agent / claude code / hermes », « superviser un
  agent », « continuer/reprendre une session », « exporter une session », « voir
  où un agent s'est arrêté », « babysitter un agent », ou orchestrer un workflow
  long avec un agent qui code pendant qu'un autre (ou Claude) joue l'humain."
---

# Agent Session Orchestration (agentproto)

Méthodologie + commandes concrètes pour piloter d'autres agents de code via le
daemon **agentproto** (tools MCP `mcp__agentproto__*`). Issu d'une session
réelle.

## Principe

L'orchestrateur (toi, dans cowork) **ne code pas** : il **lance, supervise,
exporte, reprend** des sessions d'agents (claude-code, hermes). Les agents font
le travail ; l'orchestrateur découpe en petites étapes, relit chaque diff, et
donne l'étape suivante.

Avant de déléguer, colle le Brief Contract de `supervisor-session` dans chaque
brief.

## Tools agentproto essentiels

- `adapter_list({filter})` — adapters connus + statut (`supported` pas installé,
  `available` installé, `ready` setup fait). Appelle avant de spawner.
- `agent_start({ adapter, cwd, label?, model?, prompt?, workspaceSlug? })` —
  spawn une session persistante. **`cwd` doit être un chemin absolu HÔTE** (le
  daemon tourne sur la machine de l'utilisateur), sinon erreur « no cwd
  resolvable ». Renvoie `{ id: sess_xxx, adapterSessionId, cwd, … }`.
- `agent_prompt({ sessionId, prompt })` — tour suivant (multi-tours).
- `agent_output({ sessionId, since?, lastN?, waitForTurnEnd?, timeoutMs? })` —
  lit la sortie. Passe `since: nextCursor` pour ne lire que le neuf.
- `session_list({ kind?, onlyAlive?, status? })` — inventaire.
- `agent_kill`, `command_list`, `command_execute` (host shell, basenames
  allowlistés dans `<workspace>/.agentproto/allowed-commands.json` — typiquement
  `node, ls, cat, git, pnpm, npm, npx, gh, …`).

## Adapters (vérifié)

- **claude-code** : `available`. Spawné en ACP
  (`npx @agentclientprotocol/claude-agent-acp`). Resume natif câblé dans
  agentproto. **Tools intégrés** (Read, Write, Bash, Edit) — n'a PAS besoin de
  `mcpServers` pour coder.
- **hermes** (binaire `tirith`, Nous Research) : `available`. Spawné
  `hermes acp`. **Modèle par défaut `x-ai/grok-4.3` → exige des crédits Nous** ;
  sinon `HTTP 404: requires available credits`. Solutions : ajouter des crédits,
  ou passer `model: "anthropic/claude-sonnet-4-6"` au spawn / `/model …` en
  cours.

### ⚠️ CRITIQUE — hermes SANS mcpServers = chat-only (aucun tool)

**Piège n°1, vécu en vrai.** `claude-code` a des tools intégrés (Read, Write,
Bash, Edit) — il code out of the box. **hermes n'en a AUCUN en ACP** — il faut
les monter explicitement via `mcpServers` au spawn.

Sans `mcpServers`, hermes reçoit le prompt, switched model, echo le brief,
`turn-end (completed)` — mais **0 tool calls**. Il ne lit aucun fichier, n'écrit
rien, ne lance aucune commande. On dirait qu'il comprend mais ne fait rien.

**Fix obligatoire pour hermes** :

```json
{
  "adapter": "hermes",
  "mcpServers": [
    {
      "name": "agentproto",
      "transport": "http",
      "ref": "http://127.0.0.1:18790/mcp"
    }
  ]
}
```

Donne à hermes `read_file`, `write_file`, `execute_command`, etc. depuis le
daemon.

**Vérification** : après spawn, `agent_output` — si tu vois `[tool] read` ou
`[tool] execute`, ça marche. Si tu ne vois que du texte + `turn-end`, les
mcpServers manquent.

**Note** : le spawn avec `mcpServers` peut prendre ~40s (le daemon monte le MCP
dans le process hermes). Timeout ≥ 120s sur l'appel MCP `agent_start`.

## Pattern 1 — Launch-and-leave (orchestration légère, zéro polling)

1. Lance la/les session(s), **note les `sess_xxx`** (et `nextCursor`).
2. **Ne poll PAS en boucle** (ça brûle des tokens dans TON contexte).
   Ré-engage-toi sur : un ping utilisateur, un event notify, ou un check espacé.
3. Au ré-engagement : `agent_output({ sessionId, since: <curseur> })` → lignes
   neuves seulement. Les transcripts persistent → rien perdu après restart.
4. `agent_output({ waitForTurnEnd:true, timeoutMs:45000 })` **uniquement ≤ 45
   s** et seulement quand tu attends activement une complétion imminente. La
   requête MCP coupe à ~60 s : au-delà tu obtiens « Request timed out », pas un
   retour.

## Pattern 2 — Babysitter un agent débutant pas-à-pas

Pour un agent qui « s'arrête souvent en chemin » (ex. hermes/grok) :

1. **Amorce** une session fraîche avec le `cwd` du repo + le contexte exact
   (fichier, objectif, pattern à suivre, liste des étapes).
2. **Une étape par tour** : « migre UNIQUEMENT la méthode X, puis STOP et rends
   un compte-rendu + statut compile. Ne fais rien d'autre. »
3. `waitForTurnEnd` → **relis le diff** → valide ou corrige → `agent_prompt`
   avec l'étape suivante. Répète.
4. Règle d'or du superviseur : tu **lis** (le code, l'état) mais tu **ne codes
   pas**.

## Pattern 3 — Voir où une session s'est arrêtée SANS payer un resume

Le resume recharge tout l'historique dans le contexte (coûteux). Pour juste
**relire** où ça en est, lis la source persistée :

- **hermes** : `~/.hermes/state.db` (SQLite). Via `node:sqlite` en lecture seule
  :
  ```js
  const { DatabaseSync } = require("node:sqlite")
  const db = new DatabaseSync(process.env.HOME + "/.hermes/state.db", {
    readOnly: true,
  })
  // dernières lignes d'une session :
  db.prepare(
    "select role,tool_name,substr(content,1,600) c from messages where session_id=? order by id desc limit 8"
  ).all(id)
  ```
  Tables : `sessions` (méta :
  `title, model, message_count, input_tokens, output_tokens, estimated_cost_usd, …`) +
  `messages` (`role, content, tool_calls, tool_name, reasoning, timestamp`).
- **claude-code** : `~/.claude/projects/<cwd-encodé>/<sessionId>.jsonl`
  (cwd-encodé = `cwd.replace(/\//g,"-")`), format messages Anthropic (blocs
  `text` / `tool_use` / `tool_result`), un event JSON par ligne.

## Pattern 4 — Exporter une session en markdown lisible

Le flux ACP live (`agent_output`) est bruité (ANSI, `[thought]`, `[tool]`). Pour
de l'**archivage/lecture**, lis la source propre persistée et rends du markdown.
Script de référence fourni : **`scripts/hermes-export.mjs`** (hermes → markdown
: en-tête méta, tours 🧑/🤖/🔧, raisonnement en `<details>`, tool calls, sorties
tronquées). Usage : `node scripts/hermes-export.mjs <sessionId> [out.md]`.

Hermes a aussi un export natif (JSONL only) :
`hermes sessions export --session-id <id> -` et `hermes sessions list`.

## Pattern 5 — Reprendre (resume) une session avec son contexte

- **hermes** (CLI natif) : `hermes --resume <id>` / `-r <id>` (par id ou titre),
  `hermes --continue` / `-c` (dernière, ou par nom). Recharge tout depuis
  state.db.
- **claude-code** : `claude --resume <id>` (câblé dans agentproto via
  `RESUME_STRATEGIES`).
- Mapping clé : dans les deux stores, l'id source == l'`adapterSessionId` du
  `SessionDescriptor` agentproto (hermes en ACP enregistre la session sous le
  même UUID, `source='acp'`).
- **Resume = continuer (coûteux, recharge le contexte) ; Export = relire
  (gratuit, read-only).** Choisis selon le besoin.

## Pattern 6 — Orchestration durable (cible long terme)

Le vrai « babysitter » fiable ne vit pas dans cowork (dépend de l'app ouverte)
mais **dans agentproto** : un moteur qui s'abonne in-process aux events de
session (`turn-end`, `awaiting-input`, `exited`), enchaîne les étapes, répond
aux questions selon une policy, et **n'escalade à l'humain (webhook `notifyUrl`)
que quand c'est vraiment bloqué**. Livré via `workflow_*`
(`workflow_start`/`workflow_status`/`workflow_cancel`/
`workflow_escalation_resolve`) — `routine_start` et le reste de `routine_*`
ont été **RETIRÉS** (l'ancien moteur impératif `RoutineRunner` a été retiré en
Phase B2 ; les tools ont survécu comme alias DEPRECATED le temps d'une
fenêtre de dépréciation, puis ont été retirés entièrement en Phase B3 — ils
n'existent plus). Surfaces à exposer : `session_monitor({sessionIds})`,
`session_events_poll({since})`, webhook de notification. C'est « un agent qui
babysit un autre agent en jouant l'humain », sans polling tokenivore.

## Pattern 7 — Multi-session supervision (session_monitor)

**Mise à jour 2026-07-02 : `wait_for_any` a été renommé `session_monitor`**
(même shape — `sessionIds`, `timeoutMs`, `event` — plus un paramètre `since` en
plus, cf. gotcha ci-dessous). Le nom `wait_for_any` n'existe plus côté daemon ;
si un outil/skill le référence encore, c'est du texte obsolète, pas un tool à
chercher.

Pour surveiller N sessions en parallèle sans polling tokenivore :

1. Spawn tes N sessions, note les `sess_xxx`.
2. Appelle
   `session_monitor({ sessionIds: [...], timeoutMs: 45000, event: "turn-end" })`.
3. Dès qu'une session finit son tour, tu récupères son output, puis rappelle
   `session_monitor` sur les sessions restantes.
4. Ne construis PAS de script de polling custom en `execute_code` — c'est
   exactement ce que `session_monitor` fait nativement (multiplexed long-poll
   sur l'event bus du daemon).

**Limitation actuelle** : `session_monitor` retourne sur le PREMIER hit
seulement (même limite que l'ancien `wait_for_any` — le renommage n'a pas changé
cette sémantique). Pour un monitoring qui retourne TOUTES les sessions fired +
les pending en un seul appel, il n'existe toujours pas d'équivalent bloquant
unique — la manière correcte de couvrir ça aujourd'hui est de combiner :
`session_monitor` pour bloquer sur le premier hit, puis
`session_events_poll({ since })` juste après pour rafler d'un coup, sans
bloquer, tout ce qui s'est aussi déclenché entre-temps sur les autres sessions
(au lieu de reboucler `session_monitor` une par une). `since` prend le curseur
retourné par un appel `session_events_poll` précédent.

## Pattern 7-bis — Attendre en CLI sans le drop 45 s (`agentproto sessions wait`)

`session_monitor` (MCP) bloque **au max ~45-49 s** puis timeout — sous le
plafond de requête MCP. Sur un tour long (un agent qui code 20 min sans turn-end
intermédiaire), tu dois donc le **re-lancer en boucle au premier plan**, ce qui
crame le contexte de l'orchestrateur (vécu : ~15 re-appels sur un seul tour
deepseek).

La CLI a l'équivalent SANS ce plafond :

```bash
agentproto sessions wait <sessionId|name> \
  --until turn-end|awaiting-input|exited|any \
  --timeout 1800000 --json         # budget total 30 min, pas 45 s
# ou : --policy <policyId>  → attend la résolution d'une policy au lieu d'un event
```

En interne il **enchaîne des tranches serveur de ~50 s avec un curseur `since`
qui avance** jusqu'à épuiser le budget `--timeout` — donc UN seul appel attend
30 min (ou plus). Deux gains décisifs :

1. **Lance-le en arrière-plan** (depuis cowork : une tâche Bash background). Tu
   es notifié quand ça fire, **zéro polling au premier plan, zéro contexte
   brûlé**. C'est LA bonne façon d'attendre un tour long.
2. **Robuste au daemon qui tombe** : si le daemon meurt en cours d'attente, la
   requête HTTP échoue et la commande sort (non-zéro) → tu es notifié de la
   panne aussi, au lieu de rester bloqué.

Quand utiliser quoi : `session_monitor` (MCP) pour un check multiplexé rapide
DANS un tour (N sessions, premier hit) ; `agentproto sessions wait` (CLI,
backgroundé) pour une **longue** attente d'un tour/session sans tenir le
contexte. Codes de sortie : `0` = event matché, non-zéro = timeout budget /
session absente / daemon injoignable.

## Pattern 8 — Déléguer un vrai PR-worktree (implémentation → PR mergée)

Vécu en vrai sur une session d'orchestration complète, 2026-07-01 : 4 plans
implémentés en parallèle, 8 worktrees, 6 PR mergées, plusieurs conflits en
cascade. Ce pattern couvre le cycle complet spawn → PR mergée, au-delà du
Pattern 1 (launch-and-leave, qui ne couvre que le spawn).

1. **Worktree dédié, toujours** (déjà couvert ailleurs, rappel) :
   `_agentproto-worktrees/<feature>/` + branche `feat/<feature>` off `main`,
   jamais dans l'arbre principal.
2. **PLAN.md ne doit JAMAIS être commité.** Chaque worktree qui écrit un PLAN.md
   à la racine (convention établie) entre en collision avec TOUT AUTRE PLAN.md
   déjà mergé sur main sous le même nom — vécu 4× la même session
   (cron-scheduler vs session-liveness, #142's plan vs cron's, etc.).
   Instruction à donner explicitement à chaque session : garder PLAN.md
   untracked (ou `git rm` s'il a été commité par erreur dans une phase de
   planning antérieure), et plier le contenu utile dans le corps de la PR
   (`gh pr create --body`) plutôt que dans un fichier commité.
3. **Aucune attribution IA dans les commits/PR.** Les sessions claude-code
   ajoutent par défaut `Co-authored-by: Claude...` aux commits et
   `🤖 Generated with...` au corps de PR — même défaut que Claude Code lui-même.
   Si tu veux des commits/PR qui lisent comme du travail humain ordinaire,
   l'instruction doit être **explicite dans CHAQUE prompt de spawn** (rien ne la
   retient au niveau daemon aujourd'hui) : "no Co-authored-by trailer, no
   Generated-with footer." Nettoyer un corps de PR déjà mergé est sans risque
   (`gh pr edit --body-file`, pure édition de texte GitHub) ; ne JAMAIS réécrire
   un historique de commit déjà mergé pour ça (rebase + force-push
   disproportionnés pour un fix cosmétique).
4. **Ne JAMAIS faire confiance à un "done" sans vérification indépendante.**
   Toujours re-dériver la vérité via
   `git log`/`git merge-base --is-ancestor origin/main HEAD`/`gh pr view --json mergeable,mergeStateStatus, reviewDecision`/`gh pr checks`
   — PAS juste lire le résumé texte de la session. Vécu : un bot CI ("Auto-fix
   from review") a rapporté `pass` sans rien pousser ; un review automatique a
   d'abord flaggé un vrai bug puis deux reviews suivantes l'ont incorrectement
   "approuvé" sans que le code ait changé — la seule façon de trancher était de
   lire le diff soi-même.
5. **Conflits en cascade = attendu, pas exceptionnel.** Plusieurs branches
   soeurs partageant des fichiers-carrefour (`http-server.ts`,
   `orchestration-tools.ts`, `index.ts`, `define-agent-cli.ts` côté
   agentproto/ts) entrent en conflit **séquentiellement** à mesure que chacune
   merge avant les autres. Écris un brief de résolution précis (quel bloc
   garder, pourquoi, quel côté est juste un artefact textuel vs une vraie
   divergence de logique) plutôt que de laisser la session deviner — surtout
   quand deux branches ont indépendamment implémenté la même plomberie de façon
   textuellement différente mais sémantiquement identique.
6. **Piège spécifique : "cherry-pick une branche soeur non-mergée pour ne pas
   attendre" garantit un second conflit, plus dur, une fois que cette branche
   merge réellement via GitHub** (le commit de merge GitHub a un hash/forme
   différent du merge brut branche-à-branche, même si le contenu logique est
   identique). C'est un vrai compromis (démarrer plus tôt vs. conflit garanti
   plus tard), pas une erreur en soi — mais le documenter/l'anticiper dans le
   prompt de la session qui devra le résoudre, plutôt que d'être surpris.
7. **Avant de croire que du code mergé sur `main` est "en prod" côté daemon
   local : vérifie que le daemon tourne un build frais.**
   `ps aux | grep agentproto` → note le PID et l'heure de démarrage ; compare à
   `ls -la packages/runtime/dist` (mtime du build). Un daemon démarré avant tes
   derniers merges tourne un vieux build — aucune des features fraîchement
   mergées n'est réellement testable via les tools MCP tant que tu n'as pas
   rebuild + relancé (voir Gotcha "Post-reboot" ci-dessous). **Ne relance PAS le
   daemon s'il supervise une session encore active** — ça la tue sans
   récupération propre (le resume recharge le contexte, ce n'est pas gratuit).

## Pattern 9 — Ressusciter une session killed AVEC continuité (session_restart)

Vécu en vrai 2026-07-01/02 : un restart du daemon tue des sessions en plein
travail (`error: "session absent at reload"`), mais **la conversation n'est pas
perdue** — `adapterSessionId` reste dans le descriptor même `killed`, et
claude-code/hermes ont persisté leur état côté adaptateur.

- **CLI** (dispo depuis longtemps, seule voie tant que #151 n'était pas mergé) :
  `agentproto sessions restart <id-or-name>` — relit le descriptor (mémoire OU
  historique), choisit la stratégie de resume (PTY-native > ACP resume via
  `adapterSessionId` > PTY plain > erreur pour une session `command` générique),
  et spawn un NOUVEAU `sess_xxx` qui reprend le fil. Prouvé en vrai : deux
  sessions tuées par un restart daemon, relancées via cette commande, reprises
  avec leur brief complet.
- **MCP** `session_restart({ idOrName, cols?, rows? })` — même logique
  in-process (PR #151, mergé 2026-07-02), pour un orchestrateur qui n'a pas
  accès shell. Retourne `{ id, resumedFrom, resumeVia }`. **Racine `/mcp`
  uniquement, pas dans le subset scopé par défaut** (même posture que
  `terminal_start`/`command_execute` — privilégié). Vérifié en vrai avec un vrai
  appel : `resumedFrom` + `resumeVia:"resumed via ACP"` corrects, même
  `adapterSessionId` que la session d'origine.
- **Avant #151**, un orchestrateur MCP-only (pas d'accès Bash/CLI) n'avait
  **aucun moyen** de ressusciter une session avec continuité — juste
  `agent_start` frais, sans le fil de la conversation. C'est maintenant comblé.

## Gotchas (vécus)

- **Modèle** : l'enum de `model` dépend du daemon ; vérifie via l'erreur si
  rejeté.
- **Post-reboot** : `agentproto serve` peut relancer un vieux build publié.
  Refaire `pnpm -r build` (dans `projects/agentproto/ts`) + relancer le daemon
  en `--cli workspace` + reconnecter le connecteur.
- **`awaitingInput` sur-signale** : il vaut « tour fini, j'attends » aussi bien
  que « bloqué sur une question ». Pour distinguer, lis la dernière ligne de
  contenu (une vraie question finit souvent par `?` / « valider / décision / ok
  pour toi »).
- **Sessions killed** : ne badge `awaitingInput` que sur les sessions `running`.
- **`node:sqlite`** : Node ≥ 22, API expérimentale ; ouvre toujours
  `{readOnly:true}` (la DB est verrouillée par hermes en cours d'usage ; gère
  `SQLITE_BUSY`).
- **MCP HTTP Accept header** : le daemon MCP exige
  `Accept: application/json, text/event-stream`. Sans les deux, erreur
  `Not Acceptable`. Si tu fais du curl/Python direct.
- **`session_monitor` boucle sur session déjà idle** : si une session a déjà
  fini son tour avant le premier appel, le tool retourne immédiatement
  (race-free replay via le ring). Mais en boucle, il peut retourner la MÊME
  session déjà idle à chaque itération si tu ne passes pas `since` — filtre les
  sessions déjà traitées dans ton code, ou mieux, passe le `nextCursor` du
  dernier `session_events_poll`/`session_monitor` en `since` pour que le daemon
  ne replay que ce qui est vraiment nouveau.
- **Un changeset avec un nom de fichier copié = conflit garanti.** Vécu
  2026-07-02 : une session briefée "ajoute un changeset" a vu
  `.changeset/pr-147-review.md` (déjà mergé sur main, ajouté par le bot reviewer
  d'une AUTRE PR) et a réutilisé **le même nom littéral** au lieu d'un slug
  unique — collision add/add au merge (`mergeable: CONFLICTING`). Le nom
  `pr-<N>-review.md` est LE nom que le bot reviewer génère lui-même par PR, pas
  une convention à copier à la main. Instruction à donner : soit laisser
  `pnpm changeset` générer un nom aléatoire, soit choisir explicitement un slug
  propre à la feature (`fix-<feature>.md`).
- **`gh pr view --json mergeable` : `CONFLICTING` peut être un artefact
  transitoire de cache GitHub, pas un vrai conflit.** Vécu 2× (PR #134
  changeset-release après un force-push, PR #147 juste après merge) :
  `mergeable`/`mergeStateStatus` affichent un état incohérent pendant quelques
  secondes après un push/force-push, avant que GitHub ne recalcule. Avant de
  conclure à un vrai conflit : `git merge-tree <base> <ours> <theirs>` (zéro
  `<<<<<<<` = mécaniquement clean) et re-check quelques secondes après. Idem
  pour `statusCheckRollup` : un contexte nommé "Agentic review" peut apparaître
  en double (FAILURE stale + SUCCESS frais) sur des commits successifs de la
  même PR — l'unique source de vérité propre est
  `gh api repos/<repo>/commits/<sha>/status` sur le HEAD sha exact, ou le run CI
  déclenché par le `push` sur `main` après merge (pas le rollup PR).
- **APPROVED + checks verts ≠ mergé.** Ce repo a une couche "maintainer" (judge
  IA, `.github/agentic-review.json` → `merge.maintainer:true`) qui peut retenir
  l'auto-merge sur un changement jugé conséquent (refactor de logique partagée,
  gros nouveau script) même après une review APPROVED — elle poste un
  commentaire explicite
  `🛑 Auto-merge withheld by the maintainer — @<escalateTo> please review` et
  attend un merge humain manuel. Ne pas assumer "review OK + CI vert = ça va
  merger tout seul" ; check les commentaires de la PR pour ce message avant de
  conclure qu'une PR est bloquée par une vraie erreur.
- **`pnpm -r build` + relancer le daemon dans la foulée peut se courir la course
  avec l'écriture du dist.** Vécu 2026-07-02 : un restart lancé quasi en même
  temps qu'un `pnpm -r build` a démarré le daemon sur un dist pas encore
  totalement à jour (uptime du process ≈ mtime du dist à quelques secondes près)
  — un tool fraîchement ajouté (`session_restart`, PR #151) n'apparaissait pas
  dans `tools/list` malgré un code source propre et un commit mergé. Pas un bug
  de wiring — juste un restart trop précoce. Vérifie TOUJOURS via le
  `tools/list` du daemon lui-même (`POST /mcp` `{"method":"tools/list"}`) après
  un restart post-merge, plutôt que de faire confiance au ToolSearch côté client
  (qui peut lui-même être caché sur un ancien manifest).
