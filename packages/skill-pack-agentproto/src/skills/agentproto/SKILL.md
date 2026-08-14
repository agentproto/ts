---
name: agentproto
description:
  Operate and build on agentproto — the AIP open-standard agent protocol and its
  `agentproto` CLI + daemon. Use to run/serve sessions, drive imported MCP tools
  (the substrate the local-browser / linkedin / etc. skills proxy through), or
  to author tools/drivers in projects/agentproto/ts (defineTool → implementTool
  → defineDriver, projected to cli/http/mcp/sdk/mastra/ai-sdk).
metadata:
  tags: agentproto, aip, cli, daemon, mcp, driver, tool, runner
---

## When to use

- "Start / check / restart the agentproto daemon", "what's it serving", session
  control, workspace registration.
- "Drive the browser / an imported MCP through agentproto" — this is the runtime
  underneath the `browser`, `local-browser`, `linkedin`, `instagram`, … skills.
  Reach for those skills for the recipe; reach for THIS one for the plumbing (is
  the daemon up? what's imported? why isn't a tool showing up?).
- "Author / extend an agentproto tool or driver" in `projects/agentproto/ts`.
- One-shot agent turns from the CLI (`agentproto run <adapter> --prompt …`).
- "Build / extend the agentic PR review · fix · pr CI lanes" (the sandboxed
  agent that reviews PRs and opens fixes, billing our subscription) →
  `reference/ci-review-fix-lanes.md`.
- "Create / apply an agentproto skill — where does it live, how is it
  installed" (AIP-3 SKILL.md, the `skill-pack-agentproto` centralizing pack,
  `.github/agent-skills` CI skills) → `reference/authoring-skills.md`.

If you just need to act in a logged-in web app, go straight to `local-browser` /
the site skill — they assume this plumbing already works.

## What it is

agentproto is an open standard (the **AIP** specs at
<https://agentproto.sh/docs>) with a TypeScript reference implementation in this
repo and an `agentproto` CLI.

**Two-axis tool model** (`projects/agentproto/ts/README.md`):

```
ITool    @agentproto/tool     defineTool(...)              the contract (no body)
Tool     @agentproto/driver   implementTool(handle, body) contract + typed body
Driver   @agentproto/driver   defineDriver({...})         bundle of tools + infra
```

- **Drivers** (`packages/driver/<kind>/`) run a tool over a transport: `builtin`
  · `cli` · `http` · `mcp` · `sdk`.
- **Adapters** (`adapters/<framework>/`) re-express the same implementation in a
  host framework: `toMastraTool`, `toAiSdkTool`.

Write the body once; project it everywhere without a rewrite.

## The runtime on this machine

The daemon ("agentproto serve") is a long-running local gateway: HTTP + MCP +
PTY sessions, optionally exposed over a Cloudflare tunnel so remote clients
(Guilde web, a phone) can drive local tools.

```
repo-local config   .agentproto/                 (per-workspace)
  runtime.json        live daemon: workspace, port (127.0.0.1:18790), pid
  allowed-commands.json   shell allow-list the daemon will execute
  remote.json / cloudflared-*.yml   tunnel wiring  (secrets — never print)

user config         ~/.agentproto/               (per-machine)
  start-daemon-{local,prod}.sh   launch scripts
  imported-mcps.json   MCPs proxied through /mcp (e.g. local-browser)
  workspaces.json      dirs the daemon may spawn sessions into
  sessions.json        live/known sessions
  config.json / credentials.json   auth + settings  (secrets)
  chrome-profile*/ chrome-mcp/   the local-browser plugin's cloned Chrome
```

**Daemon vs tunnel — when to use which:**

| Scenario                                                 | What to run                                            |
| -------------------------------------------------------- | ------------------------------------------------------ |
| Claude Code (local) using `mcp__agentproto__*` tools     | daemon only — `~/.agentproto/start-daemon-local.sh`    |
| Guilde web app / mobile / remote client needs the daemon | daemon + tunnel — `~/.agentproto/start-daemon-prod.sh` |

The tunnel (Cloudflare) exposes `127.0.0.1:18790` on a public URL with a bearer
token. Without it, the daemon is reachable only from the local machine.

**Restart** (after VS Code reboot or daemon crash): launch the profile script
directly (`~/.agentproto/start-daemon-local.sh` — exact commands in the health
check below), then reconnect the MCP server in Claude Desktop / Claude Code
settings.

Health check, in order:

1. `curl -s http://127.0.0.1:18790/health` — `{"status":"ok"}` = daemon live
   (local profile). Use `:18791` for prod profile.
2. If dead: use the **Bash tool** to launch it (Claude Code can do this
   directly):
   ```bash
   # Local profile (port 18790) — what mcp-bridge.mjs connects to:
   ~/.agentproto/start-daemon-local.sh &>/tmp/agentproto-daemon.log &
   sleep 3 && curl -s http://127.0.0.1:18790/health
   # Add --cli workspace if you need unpublished local fixes:
   ~/.agentproto/start-daemon-local.sh --cli workspace &>/tmp/agentproto-daemon.log &
   ```

**`--cli` flag** — controls which binary the daemon runs (orthogonal to
profile):

```bash
~/.agentproto/start-daemon-local.sh                  # local profile :18790, published binary
~/.agentproto/start-daemon-local.sh --cli workspace  # local profile :18790, local build ← use this for unpublished fixes
~/.agentproto/start-daemon-prod.sh  --cli workspace  # prod profile  :18791, local build + tunnel
~/.agentproto/start-daemon-prod.sh --cli /abs/path/to/cli.mjs
```

Use `--cli workspace` when local packages have unpublished fixes or you need
adapters that aren't published yet (e.g. `adapter-claude-code` from the
workspace).

> **Port trap**: the `mcp-bridge.mjs` (Claude Desktop MCP connection) hardcodes
> port **18790** = local profile. Using `start-daemon-prod.sh` (port 18791)
> makes the bridge fail with "Unable to connect". Always use
> `start-daemon-local.sh` when the goal is fixing the Claude Desktop MCP tools.

**Persistence across restarts** — the daemon writes a per-session transcript
and reads it back at boot:

```
~/.agentproto/sessions/<sessionId>/events.jsonl   # per-session transcript (events, one JSON per line)
```

After restart: `agent_output` on a ghost session returns the saved transcript
(not `[]`). Sessions that were alive before the fix was deployed have no
transcript file — they stay empty until the next clean shutdown.

3. After daemon is up, the **MCP connection** in Claude Desktop must be manually
   reconnected (settings → disconnect/reconnect on the `agentproto` server).
   The `mcp__agentproto__*` tools reappear once reconnected.
4. Imported tools missing? Check `~/.agentproto/imported-mcps.json`, then
   `mcp_imported_status` / `mcp_imported_tool_list` once connected.

## CLI cheat-sheet

```text
agentproto auth      <login|status|logout>      authenticate against a remote host
agentproto config    <show|get|set|unset|edit>  ~/.agentproto/config.json
agentproto daemon    <install|uninstall|…>      run as a launchd background service
agentproto install                              interactive picker → type then slug
agentproto install   <slug>                     install adapter CLI + run setup
agentproto install   <slug> --skip-setup        install only (no setup)
agentproto setup     <slug>                     re-run an adapter's setup (idempotent)
agentproto setup     <slug> --force             re-run ignoring ledger + skip_if
agentproto setup     <slug> --only <stepId>     re-run one step only
agentproto run       <slug> --cwd . --prompt …  spawn adapter, one turn, exit
agentproto serve     [--connect <wss>]          long-running daemon (HTTP+MCP+sessions)
agentproto workspace <add|list|remove|use>      dirs the daemon can spawn into
agentproto sessions  [...]                       browse + control live sessions
```

One-shot turn (machine-readable with `--json` → NDJSON, one event per line):

```bash
agentproto run claude-code --cwd . --prompt "summarise this repo"
echo "summarise CHANGELOG.md" | agentproto run claude-code --json
agentproto run claude-code --resume <session-id>
```

Spawn + attach a real PTY session:

```bash
agentproto serve &
agentproto sessions terminal --name claude-tui --attach -- claude
```

## agentproto-playground MCP (AIP authoring — the main one to use)

The **`agentproto-playground`** MCP (script:
`~/.local/bin/agentproto-playground-mcp`) exposes **6 verbs × N doctypes**.
Tools appear as `mcp__agentproto-playground__<verb>_<doctype>`.

### Registered doctypes (core)

| Doctype        | MCP name  | File written                   | Required `params`                                  |
| -------------- | --------- | ------------------------------ | -------------------------------------------------- |
| AIP-14 tool    | `tool`    | `tools/<id>/TOOL.md`           | `id`, `description`, `inputSchema`, `outputSchema` |
| AIP-42 agent   | `agent`   | `.agents/<id>/AGENT.md`        | `id`, `description`, `model`                       |
| AIP-39 action  | `action`  | `.actions/<slug>/ACTION.md`    | `id`, `description`, `verb`, `target_kind`         |
| AIP-41 routine | `routine` | follows routineSpec convention | `id`, `description`, `trigger`                     |

Plus any workspace extensions (AIP-40) auto-register as `create_<ext_slug>`,
e.g. `create_playground_deal`.

### Verb signatures (same pattern for every doctype)

```
create_<name>  { params: object, dir: string, body?: string, dryRun?: boolean }
               → writes <dir>/<filePattern>; dryRun=true = validate + return content, no write

load_<name>    { path: string }
               → { path, handle, body } — reads manifest from disk

list_<name>    { dir: string, skipDirs?: string[] }
               → array of handles found under dir
               ⚠ Point at a SPECIFIC workspace dir (e.g. "playground/workspace"), NOT the
                 repo root — doc fixtures in site/ and agentproto/specs/ contain the same
                 standard-library agents and will produce duplicates.
               Default skipDirs: ["node_modules", ".git", "dist", ".next", ".turbo"]

update_<name>  { path: string, patch: object, body?: string }
               → load → shallow-merge patch → write; only keys in patch change

resolve_<name> { block: EXACTLY ONE OF: { "inline": {...params} } | { "ref": "@scope/id" }
                              | { "file": "relative/path.md" },
                 baseDir?: string }
               → fully-typed handle (validates frontmatter schema only)
               ⚠ Schema-only validation: cross-doc refs (tools[], skills[], etc.) are stored
                 as opaque strings and are NOT existence-checked at resolve time. A handle that
                 resolves cleanly does NOT confirm the referenced tools/agents are registered.
               ⚠ The `ref` form throws at runtime ("no resolveRef provided") unless you supply
                 baseDir and the playground has a registry. Prefer `inline` or `file` forms.

delete_<name>  { path: string }
               → removes the manifest file
```

### ToolSearch gotcha — session tools need `select:` not keyword search

The daemon session tools (`agent_start`, `session_list`, etc.) are **deferred
tools** in Claude Code. Keyword-based ToolSearch finds nothing because deferred
tools are not in the keyword index. You must use exact-name `select:`:

```
ToolSearch("select:mcp__agentproto__agent_start,mcp__agentproto__session_list,mcp__agentproto__agent_output,mcp__agentproto__agent_prompt")
```

The playground MCP (`mcp__agentproto-playground__*`) and the daemon MCP
(`mcp__agentproto__*`) are two different servers — playground is authoring-only
(these 6 verbs), daemon has the session/runtime tools. Both need separate
ToolSearch loads.

### `create_agent` — full params

```jsonc
{
  "params": {
    "id": "my-agent", // required: [a-z0-9@._/-]+
    "description": "Does X by Y.", // required: 1-2000 chars
    "model": "anthropic/claude-sonnet-4-6", // required
    // optional:
    "version": "1.0.0",
    "tools": ["echo"], // AIP-14 tool refs
    "skills": [{ "file": ".claude/skills/agentproto/SKILL.md" }],
    "memory": { "scope": "per-conversation", "retention_turns": 50 },
    "autonomy": 5, // 0-10
    "boundaries": ["Never commit without approval"],
    "traits": { "diligence": 8 },
    "tags": ["research"],
  },
  "dir": "playground/workspace", // workspace-relative directory
  "body": "You are …\n", // system prompt (markdown body)
  "dryRun": false,
}
```

### `create_tool` — full params

```jsonc
{
  "params": {
    "id": "my-tool", // required
    "description": "Does X.", // required
    "inputSchema": {
      "type": "object",
      "properties": { "query": { "type": "string" } },
      "required": ["query"],
    },
    "outputSchema": {
      "type": "object",
      "properties": { "result": { "type": "string" } },
    },
    // optional:
    "approval": "auto", // auto | always | on-mutate | policy:<name>
    "risk_level": 0, // 0-3
    "cost_class": "trivial", // trivial | metered | expensive
    "timeout_ms": 30000,
    "idempotent": true,
    "mutates": [],
    "tags": ["example"],
  },
  "dir": "playground/workspace",
}
```

### Workflow: dry-run an agent before writing

```
1. create_agent { params: {...}, dir: "...", dryRun: true }  → validate
2. If ok → create_agent { dryRun: false }                   → write AGENT.md
3. resolve_agent { block: { file: ".agents/my-agent/AGENT.md" }, baseDir: "playground/workspace" }
   → fully resolved handle (confirms wiring)
4. Run it: agentproto run my-agent --cwd . --prompt "…"
   OR via daemon: agent_start { adapter: "claude-code", prompt: "…" }
```

---

## Daemon MCP tools (available as `mcp__agentproto__*`)

The daemon at `http://127.0.0.1:18790/mcp` exposes these tools directly:

**Filesystem** (workspace-scoped):

- `file_read { path }` · `file_write { path, content }` ·
  `directory_list { path? }`
- `file_info { path }` · `directory_create { path }` ·
  `file_delete { path }`

**Shell execution** (allowlist-gated via `.agentproto/allowed-commands.json`):

- `command_execute { command, args?, cwd?, stdin?, timeoutMs?, async? }` → sync:
  `{ exitCode, stdout, stderr, durationMs }` · async: `{ commandId }` · blocked
  (not in allowlist): `{ commandId, status: "pending_approval" }`
- `command_log_tail { commandId }` →
  `{ status, stdout, stderr, exitCode?, durationMs }`
- There is no command-cancel verb — a running async command cannot be cancelled
  through the daemon tools.

**Async pattern** (use for builds, `claude -p`, tests — MCP transport timeout is
~60 s):

```
r = command_execute { command: "pnpm", args: ["test"], async: true }
loop: out = command_log_tail { commandId: r.commandId }; break if out.status != "running"
```

**Command permission flow** (when a command is blocked by the allowlist):

```
r = command_execute { command: "foo", ... }
# → { commandId, status: "pending_approval" }  ← not in allowlist

permissions_list {}
# → { count, items: [{ requestId, command, args, cwd, risk, status, waitingSecs }] }

permissions_respond { id: r.requestId, decision: "approve" }
# → fast commands return output inline; slow ones: poll command_log_tail

permissions_respond { id: r.requestId, decision: "approve", scope: "always" }
# → also writes command to .agentproto/allowed-commands.json (never asks again)

permissions_respond { id: r.requestId, decision: "deny" }
# → exitCode -1, stderr "Permission denied by operator."
```

**Allowlist setup** (if command_execute is blocked with "not in allowlist"):

```bash
echo '{"version":1,"commands":["claude","gh","pnpm","node","git","npx"]}' > .agentproto/allowed-commands.json
```

**Agent sessions** (long-running adapter processes):

- `adapter_list { filter?: "all"|"available"|"ready" }` → full catalog with
  `status` per entry:
  - `"supported"` — known adapter, package not installed yet → suggest
    `agentproto install <slug>`
  - `"available"` — installed and importable, setup not yet run → call
    `agentproto setup <slug>`
  - `"ready"` — installed + setup complete (or no setup required) → safe to
    spawn
  - Default `filter: "all"` always returns the full catalog (never empty). Use
    `filter: "ready"` to find what can be spawned immediately.
- `command_list { adapter: "claude-code" }` → slash-command catalog for one
  adapter
- `agent_start { adapter, workspaceSlug?, cwd?, prompt?, label?, model? }` →
  `{ sessionId }`
  - Only works for adapters with `status: "available"` or `"ready"`. If
    `adapter_list` shows `"supported"`, the spawn will fail — tell the user to
    install first.
- `agent_prompt { sessionId, prompt }` → queued if mid-turn, dispatched on
  turn-end
- `agent_output { sessionId, since?, lastN?, waitForTurnEnd?, timeoutMs? }` →
  incremental cursor + `awaitingInput: bool`
- `permissions_respond { id, decision }` → reply to a pending agent question
- `agent_kill { sessionId }`
- `session_list { kind?, onlyAlive?, status? }` → all sessions

**`awaitingInput` flag**: `agent_output` returns `awaitingInput: true` when the
agent ended its last turn with text (a question or confirmation request) rather
than a tool call. Check it after `waitForTurnEnd: true` returns; use
`permissions_respond` to reply.

**`permissions_respond` decisions**:

| `decision` | Effect                                       |
| ---------- | -------------------------------------------- |
| `approve`  | Selects an allow option — proceed.           |
| `deny`     | Selects a reject option (or cancels).        |

These are the only two decisions. Optional `scope: "once" | "always"` (default
`"once"`) — with `approve`, `"always"` prefers allow-always when the request
offers it. There is no `note` field.

**Permission scope by source** — three kinds of approvals, three different
paths:

| Source                                             | Gate                         | How to resolve                             |
| -------------------------------------------------- | ---------------------------- | ------------------------------------------ |
| `command_execute` (out-of-allowlist)               | `status: "pending_approval"` | `permissions_list` → `permissions_respond` |
| Session text output (explicit question/confirm)    | `awaitingInput: true`        | `permissions_respond`                      |
| Internal tool calls within a session (bash/edit/…) | **none** — auto-approved     | n/a                                        |

The `claude-code` adapter runs with `--dangerously-skip-permissions` /
`acceptEdits` by default, so bash/edit/write tool calls inside a session never
surface as approval requests — they execute immediately. `permissions_respond`
is only triggered when the agent ends a turn with plain text (a question, a
confirmation ask). This is intentional for autonomous runs; a supervised
`permissionMode: "ask"` option on `agent_start` that forwards ACP permission
requests as `awaitingInput` is a planned but not yet implemented feature.

**Cursor pattern** (no polling needed):

```
out = agent_output { sessionId, lastN: 20 }   # seed
cursor = out.nextCursor
agent_prompt { sessionId, prompt: "…" }
out = agent_output { sessionId, since: cursor, waitForTurnEnd: true }
# out.awaitingInput == true  →  permissions_respond { id, decision: "approve" }
# out.lines = only the new lines from that turn; cursor = out.nextCursor
```

**Available adapters**:

| Slug                | Protocol | Package                            | When to use                                                                                                                                                                          |
| ------------------- | -------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `claude-code`       | acp      | `@agentproto/adapter-claude-code`  | Long-lived ACP via `@agentclientprotocol/claude-agent-acp`. Bidirectional, multimodal, resumable. Best for long sessions.                                                            |
| `claude-code-print` | print    | `@agentproto/adapter-claude-code`  | `claude -p --output-format stream-json` — one subprocess per turn, no stale-proxy race. Simpler, more reliable.                                                                      |
| `opencode`          | acp      | `@agentproto/adapter-opencode`     | sst/opencode with first-party ACP. Multi-provider: Anthropic, OpenAI, OpenRouter, Groq.                                                                                              |
| `codex`             | acp      | `@agentproto/adapter-codex`        | OpenAI Codex via `@agentclientprotocol/codex-acp`. Modes: default / read-only / full-access.                                                                                            |
| `hermes`            | acp      | `@agentproto/adapter-hermes`       | Nous Research Hermes — skills, memory plugins, sandboxes, sub-agents. OpenRouter recommended.                                                                                        |
| `mastra-agent`      | acp      | `@agentproto/adapter-mastra-agent` | **First-party** — an AIP-42 `AGENT.md` run as a live Mastra agent (our loop/models, routed from spawn env). SQLite memory + workspace tools. Standalone via `agentproto-mastra acp`. |
| `openclaw`          | acp      | `@agentproto/adapter-openclaw`     | OpenClaw Gateway bridge — requires one-time `openclaw onboard --install-daemon`.                                                                                                     |

Resolver supports **parent-package fallback**: `claude-code-print` resolves via
`@agentproto/adapter-claude-code` (the `claudeCodePrint` named export), so no
separate npm package is needed.

**AIP-29 setup pipeline** — `agentproto install <slug>` installs the binary AND
runs post-install config automatically. `agentproto setup <slug>` re-runs config
only.

Three idempotency layers (most to least expensive):

1. `version_check` — if binary already at required version, skip install
   entirely
2. `skip_if.cmd` — per-step shell check; exit code match skips that step
3. Ledger — `~/.agentproto/setup/<slug>.json` (chmod 0600); tracks completed
   steps + captured `envValues` (injected at spawn)

Step kinds: `cmd` (shell, spinner for non-interactive / inherited stdio for
interactive), `prompt` (text/secret/boolean/select via `@clack/prompts`),
`external` (open URL), `oauth` (not yet implemented).

Persist slots: `{ env: "VAR_NAME" }` → ledger `envValues` (runner injects at
spawn) · `{ secret_slug }` → external vault reference · `{ cmd }` → piped to
config command.

**What each adapter sets up automatically:**

| Slug          | Setup steps                                                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-code` | 1. Install Claude Code CLI (`npm i -g @anthropic-ai/claude-code`)<br>2. `claude auth login` (browser OAuth) — skipped if `ANTHROPIC_API_KEY` set |
| `opencode`    | Prompt for `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY` / `OPENROUTER_API_KEY` / `GROQ_API_KEY`)                                                    |
| `codex`       | Prompt for `OPENAI_API_KEY` or `CODEX_API_KEY`                                                                                                  |
| `hermes`      | 1. Prompt for `OPENROUTER_API_KEY` (recommended)<br>2. Fallback prompt for `ANTHROPIC_API_KEY`                                                  |
| `openclaw`    | 1. `openclaw onboard --install-daemon` (skipped if `openclaw gateway probe` succeeds)<br>2. Gateway probe readiness check                        |

**Bundled catalog** — `agentproto install` (no slug) launches an interactive
`@clack/prompts` picker:

```
◆  What would you like to install?
   ● Agent CLI    claude-code, codex, opencode, hermes, openclaw
   ○ Pack         coming soon
   ○ MCP server   coming soon
```

Programmatic access:
`import { CATALOG, catalogByType } from "@agentproto/cli/registry/catalog"`.

**Slash-command catalog** — adapter manifests declare the commands they accept.
Query before composing a slash-command turn instead of hard-coding syntax:

```
command_list { adapter: "claude-code" }
# → { adapter: "claude-code", commands: [
#     { command: "/compact",  description: "…", protocols: ["acp"] },
#     { command: "/clear",    description: "…", protocols: ["acp"] },
#     { command: "/model",    description: "…", args: [{ name: "model", required: true }] },
#     { command: "/context",  description: "…", local_only: true, protocols: ["acp"] },
#     { command: "/add-dir",  description: "…", args: [{ name: "path", required: true }] },
#     …
#   ] }
```

Key fields per entry:

- `command` — the token to send verbatim as prompt text (e.g. `"/compact"`)
- `local_only: true` — handled by the ACP wrapper, never reaches the model
- `args` — positional args to append after the token
- `protocols` — which protocol variants support it (omitted = all)

`adapter_list {}` includes the same `commands[]` array per adapter entry (empty
for `"supported"` entries).

**Commands by adapter** (declared in each adapter's
`AgentCliHandle.commands[]`):

| Adapter       | Key commands                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-code` | `/compact` `/clear` `/model <id>` `/add-dir <path>` `/help` `/doctor` `/approved-tools` `/vim`<br>local-only: `/context` `/heapdump` `/extra-usage` |
| `opencode`    | `/compact` `/clear` `/model <id>` `/mode plan\|build` `/providers` `/cost` `/diff` `/undo`                                                          |
| `codex`       | `/compact` `/clear` `/model <id>` `/mode default\|read-only\|full-access` `/history` `/diff` `/undo`<br>local-only: `/context`                      |
| `hermes`      | `/compact` `/clear` `/model <id>` `/skills` `/memory` `/plugins` `/sandbox` `/status`                                                               |
| `openclaw`    | `/compact` `/clear` `/status` `/reconnect` `/plugins` `/plugin-enable <slug>` `/plugin-disable <slug>` `/config <key> [value]`                      |

**PTY terminal sessions**:

- `terminal_start { argv, cwd?, cols?, rows?, name?, label? }` →
  `{ sessionId }`
- `terminal_input { sessionId, text }` ·
  `terminal_output { sessionId, lastBytes? }` (base64)
- `terminal_kill { sessionId }` · `terminal_sessions_list {}`

**Remote tunnel**:

- `remote_enable { provider?, targetPort?, targetHost? }` → `{ url, token }`
- `remote_disable {}` · `remote_status {}`

`remote_status` returns a `source` field that tells you exactly what's
happening:

| `enabled` | `source`     | Meaning                                                                                                                                                         |
| --------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `true`    | `"live"`     | Daemon owns cloudflared (normal path — started via `remote_enable`).                                                                                            |
| `true`    | `"restored"` | Daemon restarted but cloudflared is still alive; URL recovered from `remote.json`. Bearer token is lost — call `remote_disable` then `remote_enable` to rotate. |
| `false`   | _(absent)_   | No tunnel active.                                                                                                                                               |

**Note**: `remote_status` is about the agentproto cloudflared tunnel only. The
**guilde-tunnel** GKE service (`projects/guilde/apps/tunnel`) is a separate
infra component — unrelated.

**Imported MCP proxy** — reach proxied MCPs (local-browser, etc.) through:

- `mcp_imported_status {}` → health of every alias
- `mcp_imported_list {}` · `mcp_discovered_list {}`
- `mcp_import { sourceMcpId, alias? }` · `mcp_imported_remove { id }`
- `mcp_imported_tool_list { alias }` → tool list from that alias
- `mcp_imported_call { alias, toolName, args? }` → invoke tool

You do NOT call the proxied tool by name — always go through
`mcp_imported_call`.

## AIP-42 agent manifest (AGENT.md)

Location: `.agents/<slug>/AGENT.md` or `operators/<slug>/OPERATOR.md`.

```yaml
---
schema: "agent/v1" # required, always this string
id: my-researcher # required: [a-z0-9@._/-]+, 2-80 chars
description: | # required: 1-2000 chars, one-paragraph purpose
  Does X by doing Y.
model:
  anthropic/claude-sonnet-4-6 # required: "provider/model" string
  # OR { ref, temperature, max_tokens, top_p }

# Optional
version: 1.0.0
extends: "@agentproto/agents-standard/researcher" # parent agent (chain ≤5)
tools: # AIP-14 tool refs
  - command_execute
  - ref: "@agentproto/tools/web-search"
skills: # AIP-3 skill refs
  - file: ".claude/skills/agentproto/SKILL.md"
actions: # explicit action allow-list
  granted:
    - "@agentproto/actions/shell"
memory:
  scope: per-conversation # per-conversation | per-thread | per-workspace | none
  retention_turns: 50
  semantic:
    enabled: false
autonomy: 5 # 0-10 (0=always asks, 10=fully autonomous)
boundaries:
  - "Never commit to main without human approval"
traits:
  diligence: 8
  curiosity: 7
tags: [research, browser]
---
System prompt goes here as Markdown body. The body IS the system prompt — no
separate file needed.
```

**Minimum viable AGENT** (only 3 required fields + body):

```yaml
---
schema: "agent/v1"
id: my-agent
description: Summarises repos.
model: anthropic/claude-sonnet-4-6
---
You are a code summariser. Be concise.
```

**Run it**: `agentproto run my-agent --cwd . --prompt "summarise this repo"` or
via MCP: `agent_start { adapter: "claude-code", cwd: ".", prompt: "..." }`

## Authoring a tool in projects/agentproto/ts

```ts
import { defineTool } from "@agentproto/tool"
import { implementTool, defineDriver } from "@agentproto/driver"
import { z } from "zod"

const greet = defineTool({
  id: "greet",
  description: "Greets a name in the bound locale.",
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({ greeting: z.string() }),
  contextSchema: z.object({ locale: z.enum(["en", "fr"]) }),
})

const greetBuiltin = implementTool(greet, async ({ input, context }) => ({
  greeting:
    context.locale === "fr" ? `Bonjour ${input.name}` : `Hello ${input.name}`,
}))

export const greetDriver = defineDriver({
  id: "greet-builtin",
  name: "Greet (builtin)",
  kind: "builtin",
  implements: [{ tool: "greet", version: "0.1.0" }],
  implementations: [greetBuiltin],
})
```

Project the same body into a host framework — no rewrite:

```ts
import { toMastraTool } from "@agentproto/adapter-mastra"
import { toAiSdkTool } from "@agentproto/adapter-ai-sdk"
const mastra = toMastraTool(greetBuiltin, {
  source: { context: { locale: "en" } },
})
const aisdk = toAiSdkTool(greetBuiltin, { context: { locale: "en" } })
```

Build/test the workspace: `pnpm -r build && pnpm -r test` from
`projects/agentproto/ts`. Conventions to keep: this is a vendor-neutral OSS repo
— **no Guilde/Katchy/app brand names** in `@agentproto/*` source, READMEs, or
descriptions. AIP specs are the source of truth; amend the spec rather than
working around it.

## Agentic CI lanes (review · fix · pr) — see `reference/ci-review-fix-lanes.md`

The `agentproto/ts` repo drives a **sandboxed agent** to review PRs, apply
review fixes, and open PRs from an issue/request — config-driven, one composable
block, billing our **subscription** (`CLAUDE_CODE_OAUTH_TOKEN` →
`ANTHROPIC_AUTH_TOKEN`, adapter `claude-sdk`, e2b sandbox). Four layers:
`.github/agentic-review.json` (config) → `.github/agentproto-workflows/<lane>/`
(WORKFLOW.md + entry.mjs, sharing `lib/sandbox-agent.mjs`) →
`.github/actions/agentproto-run/` (daemon + driver + auth) → `ci.yml` /
`agent-command.yml` (wiring). The `fixDelivery` knob (`commit` | `pr`) chooses
push-to-branch vs open-a-PR. The reference file covers the verb model, adding a
verb/lane, the subscription-auth wiring, sandbox gotchas, the
native-vs-legacy `@agentproto-bot` discriminator, merge gates + the
capability model, and verify/smoke-test recipes.

## Authoring skills (AIP-3) — see `reference/authoring-skills.md`

Skills are AIP-3 `SKILL.md` files with three source homes: the **centralizing
pack** `packages/skill-pack-agentproto/src/skills/<slug>/` (source of truth —
edit here, `pnpm build` generates the consumable `skills/` + `.claude-plugin/` +
`dist/*.zip`); `.github/agent-skills/<name>.md` (short prompts for the PR
review/fix CI lanes, referenced from `agentic-review.json`); and the studio
`.claude/skills/` + `.agents/skills/` (a local Claude Code INSTALL that can drift
from the pack). Apply via `agentproto install skill/<slug> --pack
agentproto-plugin` (fans out into every adapter declaring `metadata.skills`, or
`--target hermes|claude-code|claude-desktop`) or the release `.zip` for Claude
Code. The reference covers the frontmatter schema, the build→apply flow, and the
drift/reconciliation rule (pack `src/skills/` is authoritative).

## Safety rails

- The daemon executes shell commands gated by
  `.agentproto/allowed-commands.json` and drives a Chrome signed into the user's
  accounts. Treat every imported-tool call as acting AS THE USER — confirm
  before anything that posts, pays, sends, or deletes.
- `runtime.json`, `remote.json`, `config.json`, `credentials.json` carry tunnel
  tokens / auth — never print or commit them.
- Don't kill/restart the daemon casually; other clients (web, phone) may be
  attached. Check `runtime.json` pid + `sessions.json` first.
