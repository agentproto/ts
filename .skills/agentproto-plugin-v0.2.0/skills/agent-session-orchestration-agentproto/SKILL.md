---
name: agent-session-orchestration-agentproto
description: "Piloter et SUPERVISER d'autres agents de code (claude-code, hermes, …) via le daemon agentproto depuis une session cowork : lancer des sessions, babysitter un agent débutant pas-à-pas, exporter une conversation d'agent en markdown lisible, reprendre (resume) une session avec son contexte, et orchestrer plusieurs agents en parallèle (launch-and-leave). Déclenche ce skill quand l'utilisateur veut « lancer un agent / claude code / hermes », « superviser un agent », « continuer/reprendre une session », « exporter une session », « voir où un agent s'est arrêté », « babysitter un agent », ou orchestrer un workflow long avec un agent qui code pendant qu'un autre (ou Claude) joue l'humain."
---

# Agent Session Orchestration (agentproto)

Méthodologie + commandes concrètes pour piloter d'autres agents de code via le
daemon **agentproto** (tools MCP `mcp__agentproto__*`). Issu d'une session réelle.

## Principe

L'orchestrateur (toi, dans cowork) **ne code pas** : il **lance, supervise,
exporte, reprend** des sessions d'agents (claude-code, hermes). Les agents font
le travail ; l'orchestrateur découpe en petites étapes, relit chaque diff, et
donne l'étape suivante.

## Tools agentproto essentiels

- `list_adapters({filter})` — adapters connus + statut (`supported` pas installé,
  `available` installé, `ready` setup fait). Appelle avant de spawner.
- `start_agent_session({ adapter, cwd, label?, model?, prompt?, workspaceSlug? })`
  — spawn une session persistante. **`cwd` doit être un chemin absolu HÔTE** (le
  daemon tourne sur la machine de l'utilisateur), sinon erreur « no cwd
  resolvable ». Renvoie `{ id: sess_xxx, adapterSessionId, cwd, … }`.
- `prompt_agent_session({ sessionId, prompt })` — tour suivant (multi-tours).
- `get_agent_session_output({ sessionId, since?, lastN?, waitForTurnEnd?, timeoutMs? })`
  — lit la sortie. Passe `since: nextCursor` pour ne lire que le neuf.
- `list_sessions({ kind?, onlyAlive?, status? })` — inventaire.
- `kill_agent_session`, `list_adapter_commands`, `execute_command` (host shell,
  basenames allowlistés dans `<workspace>/.agentproto/allowed-commands.json` —
  typiquement `node, ls, cat, git, pnpm, npm, npx, gh, …`).

## Adapters (vérifié)

- **claude-code** : `available`. Spawné en ACP (`npx @agentclientprotocol/claude-agent-acp`).
  Resume natif câblé dans agentproto.
- **hermes** (binaire `tirith`, Nous Research) : `available`. Spawné `hermes acp`.
  **Modèle par défaut `x-ai/grok-4.3` → exige des crédits Nous** ; sinon
  `HTTP 404: requires available credits`. Solutions : ajouter des crédits, ou
  passer `model: "anthropic/claude-sonnet-4-6"` au spawn / `/model …` en cours.

## Pattern 1 — Launch-and-leave (orchestration légère, zéro polling)

1. Lance la/les session(s), **note les `sess_xxx`** (et `nextCursor`).
2. **Ne poll PAS en boucle** (ça brûle des tokens dans TON contexte). Ré-engage-toi
   sur : un ping utilisateur, un event notify, ou un check espacé.
3. Au ré-engagement : `get_agent_session_output({ sessionId, since: <curseur> })`
   → lignes neuves seulement. Les transcripts persistent → rien perdu après restart.
4. `get_agent_session_output({ waitForTurnEnd:true, timeoutMs:45000 })` **uniquement
   ≤ 45 s** et seulement quand tu attends activement une complétion imminente. La
   requête MCP coupe à ~60 s : au-delà tu obtiens « Request timed out », pas un retour.

## Pattern 2 — Babysitter un agent débutant pas-à-pas

Pour un agent qui « s'arrête souvent en chemin » (ex. hermes/grok) :

1. **Amorce** une session fraîche avec le `cwd` du repo + le contexte exact
   (fichier, objectif, pattern à suivre, liste des étapes).
2. **Une étape par tour** : « migre UNIQUEMENT la méthode X, puis STOP et rends un
   compte-rendu + statut compile. Ne fais rien d'autre. »
3. `waitForTurnEnd` → **relis le diff** → valide ou corrige → `prompt_agent_session`
   avec l'étape suivante. Répète.
4. Règle d'or du superviseur : tu **lis** (le code, l'état) mais tu **ne codes pas**.

## Pattern 3 — Voir où une session s'est arrêtée SANS payer un resume

Le resume recharge tout l'historique dans le contexte (coûteux). Pour juste
**relire** où ça en est, lis la source persistée :

- **hermes** : `~/.hermes/state.db` (SQLite). Via `node:sqlite` en lecture seule :
  ```js
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.env.HOME + '/.hermes/state.db', { readOnly: true });
  // dernières lignes d'une session :
  db.prepare("select role,tool_name,substr(content,1,600) c from messages where session_id=? order by id desc limit 8").all(id);
  ```
  Tables : `sessions` (méta : `title, model, message_count, input_tokens,
  output_tokens, estimated_cost_usd, …`) + `messages` (`role, content, tool_calls,
  tool_name, reasoning, timestamp`).
- **claude-code** : `~/.claude/projects/<cwd-encodé>/<sessionId>.jsonl`
  (cwd-encodé = `cwd.replace(/\//g,"-")`), format messages Anthropic (blocs
  `text` / `tool_use` / `tool_result`), un event JSON par ligne.

## Pattern 4 — Exporter une session en markdown lisible

Le flux ACP live (`get_agent_session_output`) est bruité (ANSI, `[thought]`,
`[tool]`). Pour de l'**archivage/lecture**, lis la source propre persistée et rends
du markdown. Script de référence fourni : **`scripts/hermes-export.mjs`** (hermes →
markdown : en-tête méta, tours 🧑/🤖/🔧, raisonnement en `<details>`, tool calls,
sorties tronquées). Usage : `node scripts/hermes-export.mjs <sessionId> [out.md]`.

Hermes a aussi un export natif (JSONL only) : `hermes sessions export --session-id
<id> -` et `hermes sessions list`.

## Pattern 5 — Reprendre (resume) une session avec son contexte

- **hermes** (CLI natif) : `hermes --resume <id>` / `-r <id>` (par id ou titre),
  `hermes --continue` / `-c` (dernière, ou par nom). Recharge tout depuis state.db.
- **claude-code** : `claude --resume <id>` (câblé dans agentproto via
  `RESUME_STRATEGIES`).
- Mapping clé : dans les deux stores, l'id source == l'`adapterSessionId` du
  `SessionDescriptor` agentproto (hermes en ACP enregistre la session sous le même
  UUID, `source='acp'`).
- **Resume = continuer (coûteux, recharge le contexte) ; Export = relire (gratuit,
  read-only).** Choisis selon le besoin.

## Pattern 6 — Orchestration durable (cible long terme)

Le vrai « babysitter » fiable ne vit pas dans cowork (dépend de l'app ouverte) mais
**dans agentproto** : un `RoutineRunner` qui s'abonne in-process aux events de
session (`turn-end`, `awaiting-input`, `exited`), enchaîne les étapes, répond aux
questions selon une policy, et **n'escalade à l'humain (webhook `notifyUrl`) que
quand c'est vraiment bloqué**. Surfaces à exposer : `wait_for_any({sessionIds})`,
`poll_events({since})`, webhook de notification. C'est « un agent qui babysit un
autre agent en jouant l'humain », sans polling tokenivore.

## Gotchas (vécus)

- **Modèle** : l'enum de `model` dépend du daemon ; vérifie via l'erreur si rejeté.
- **Post-reboot** : `agentproto serve` peut relancer un vieux build publié. Refaire
  `pnpm -r build` (dans `projects/agentproto/ts`) + relancer le daemon en
  `--cli workspace` + reconnecter le connecteur.
- **`awaitingInput` sur-signale** : il vaut « tour fini, j'attends » aussi bien que
  « bloqué sur une question ». Pour distinguer, lis la dernière ligne de contenu
  (une vraie question finit souvent par `?` / « valider / décision / ok pour toi »).
- **Sessions killed** : ne badge `awaitingInput` que sur les sessions `running`.
- **`node:sqlite`** : Node ≥ 22, API expérimentale ; ouvre toujours `{readOnly:true}`
  (la DB est verrouillée par hermes en cours d'usage ; gère `SQLITE_BUSY`).
