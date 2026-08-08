# @agentproto/cli

The `agentproto` binary — host for [AIP-45 agent CLIs](https://agentproto.sh/docs/aip-45). Install adapters, run one-shot turns, spawn long-lived sessions, expose them over a tunnel, and drive an interactive PTY from your terminal or a web client.

```bash
npm install -g @agentproto/cli
```

This installs the `agentproto` executable on your `PATH`.

## Verbs

```text
agentproto auth         <login|status|logout> [--host <url>]        authenticate against a remote host
agentproto config       <show|path|get|set|unset|edit>              read/write ~/.agentproto/config.json
agentproto daemon       <install|uninstall|start|restart|stop|status|logs>  manage launchd/systemd service
agentproto install      <slug> [--force] [--dry-run] [--allow-unverified]  install an adapter's underlying CLI
agentproto plugins      <list|show|install|uninstall|enable|disable> manage runtime plugins
agentproto setup        <slug> [--force] [--dry-run] [--only ...]   re-run an adapter's setup steps
agentproto run          <slug> [--cwd <dir>] [--prompt <text>]      spawn the adapter, dispatch one turn, exit
agentproto chat         <adapter> [--model <id>] [--cwd <dir>]      interactive chat
agentproto chat-tui     <adapter> [--model <id>] [--cwd <dir>]      interactive TUI chat
agentproto models       [adapter] [--json]                          runnable models + provider-key status
agentproto run-swarm    --manifest <path> [--once] [--interval ...]  run a swarm manifest
agentproto serve        [--port <n>] [--workspace <dir>] [--connect <wss>]  local daemon
agentproto workspace    <add|list|remove|use>                       register spawn workspaces
agentproto sessions     [start|terminal|mirror|stop|...]            browse / control live sessions
agentproto browser      <install|start|list|stop|status>            manage browser sessions
agentproto tunnel       <create|list|stop|status>                   public URL tunnels
agentproto provider-preset list [--json]                            provider gateway definitions
agentproto preset       <list|show|add|delete>                       saved user spawn configurations
agentproto mcp-bridge                                               stdio MCP proxy to daemon /mcp
agentproto install-mcp  [--agent <name>...] [--all] [--yes]         register daemon MCP with coding CLIs
agentproto onboard      [--yes] [--no-skills] [--skills <slug>]     first-run setup
agentproto cron         <add|list|remove|run>                       recurring daemon jobs
agentproto worktree     <ls|new|rm|archive|gc>                       git worktree lifecycle
agentproto policy       <attach|status|wait|ack|ls|cancel>          completion-policy CLI (shell/judge gates)
agentproto permissions  <ls|approve|deny|watch>                           held tool-permission requests
agentproto acp          <ls|add|rm>                                 generic ACP agent registry
agentproto pair         <offer|accept|ls|revoke|exec>               pairing over a rendezvous broker
agentproto rendezvous   serve [--port <n>] [--host <ip>]           run a rendezvous broker
```

> `agentproto --help` prints the full usage; `--version` prints the package version.

## Quick start

```bash
# 1. Install an adapter (one-time, per slug).
npm i -g @agentproto/adapter-claude-code

# 2. One-shot: get a single turn back and exit.
agentproto run claude-code --cwd . --prompt "summarise this repo"

# 3. Daemon: keep the gateway alive so you can drive sessions over HTTP / MCP / WS.
agentproto serve &

# 4. Spawn a real terminal under PTY and attach to it.
agentproto sessions terminal --name claude-tui --attach -- claude
```

## `run` — one-shot

Spawns the adapter, sends a single prompt, streams events to stdout, exits.

```bash
# Prompt via flag
agentproto run claude-code --cwd . --prompt "what does this repo do?"

# Prompt piped over stdin
echo "summarise CHANGELOG.md" | agentproto run claude-code

# Resume an existing adapter-side protocol session (claude-code session id)
agentproto run claude-code --resume <session-id>

# Machine-readable: one event per line as NDJSON
agentproto run claude-code --prompt "hi" --json
```

For multi-turn or interactive use, see [`serve`](#serve--the-local-daemon) + [`sessions`](#sessions--browse--control-the-daemon) below.

## `install` / `setup`

```bash
agentproto install claude-code              # idempotent — skips if version_check passes
agentproto install claude-code --force      # reinstall regardless
agentproto install claude-code --dry-run    # print steps, don't execute
agentproto install claude-code --allow-unverified  # run curl/download installers with no SHA

agentproto setup openclaw                   # re-run adapter setup (env keys, login, …)
agentproto setup openclaw --only login      # only specific steps
```

Install methods are tried in declaration order (`npm`, `curl`, `brew`, …). Use `--force` to reinstall, `--dry-run` to preview steps, `--allow-unverified` to opt in to unverified curl/download installers in non-interactive contexts.

## `config` — defaults at `~/.agentproto/config.json`

Hand-editable JSON the daemon reads at boot. CLI flags on `agentproto serve` still override anything in here; the file is the place to remember choices so you don't re-type them every restart.

```bash
agentproto config show                                          # dump full config
agentproto config path                                          # print the file path
agentproto config get daemon.port                               # read one key
agentproto config set daemon.port 18791                         # number auto-detected
agentproto config set daemon.workspace ~/code/my-app
agentproto config set daemon.allowedOrigins https://guilde.work,https://app.example.com
agentproto config set tunnel.host wss://guilde.work/api/v1/agentproto/tunnel
agentproto config set tunnel.autoconnect true                   # --connect implied at next serve
agentproto config unset tunnel.host                             # forget
agentproto config edit                                          # open in $EDITOR
```

Schema (all fields optional; see [`docs/cli/reference/config-schema.md`](../../docs/cli/reference/config-schema.md) for the full reference):

```jsonc
{
  "plugins": ["@guilde/agentproto-bridge"],
  "profileAliases": { "guilde": "@guilde/runtime-profile-guilde" },
  "corpusPresetPackages": ["@agentproto/corpus-presets"],
  "daemon": {
    "workspace": "/abs/path",                  // default cwd when not passed
    "port": 18791,
    "bind": "127.0.0.1",
    "allowedOrigins": ["https://guilde.work"], // extends localhost defaults
    "strictOrigins": false,                    // when true, drops localhost defaults
    "authToken": "<random-hex>",               // stable bearer for /mcp, /events, …
    "label": "jeremy@mbp"
  },
  "tunnel": {
    "host": "wss://guilde.work/api/v1/agentproto/tunnel",
    "autoconnect": false                       // bootstrap with --connect at serve
  },
  "pairing": {
    "rendezvous": "wss://rendezvous.example/v1",
    "autoconnect": true
  },
  "defaults": {
    "skills": ["review-checklist"],
    "options": { "verbose": true },
    "adapters": { "hermes": { "options": { "model": "z-ai/glm-5.2" } } },
    "defaultRoleDepthCutoff": 1,
    "langfuseTracing": false
  },
  "acpAgents": {
    "my-agent": { "bin": "my-agent", "bin_args": ["acp"], "resumable": true }
  },
  "profiles": {
    "headless": { "daemon": { "port": 18792 }, "features": { "pty": false } }
  },
  "terminalPresets": {
    "terra": { "argv": ["bash", "-l"], "env": { "TERM": "xterm-256color" } }
  },
  "features": { "pty": true }
}
```

**About `strictOrigins`:** by default any browser on `localhost` (any port) is allowed to drive mutating routes — that's what makes Guilde dev / Vite / Storybook all "just work" without per-port config. Set `strictOrigins: true` if you want to lock the daemon down to a literal list (shared host, hardened setup). Note: any local user with shell access can read `runtime.json`'s token regardless of this setting; strict mode only narrows the browser-Origin surface.

## `daemon` — run as a background service

Wraps the host's init system so you don't keep a terminal open. macOS `launchd` ships today; Linux `systemd --user` and Windows are on the follow-up list (the verb prints a clear "not yet" until then).

```bash
agentproto config set daemon.workspace ~/code/my-project   # one-time
agentproto config set daemon.allowedOrigins https://guilde.work
agentproto daemon install                                  # write plist + bootstrap
agentproto daemon status                                   # plist? loaded? /health probe?
agentproto daemon logs --lines 30                          # tail ~/.agentproto/daemon.log
agentproto daemon stop                                     # SIGTERM
agentproto daemon start                                    # kickstart again (idempotent)
agentproto daemon restart                                  # kill + relaunch
agentproto daemon uninstall                                # bootout + delete plist
```

`install` reads the current `config.json` and bakes its `daemon.*` keys into the plist's `ProgramArguments`. Re-run `install` after any config change to refresh. Logs land in `~/.agentproto/daemon.log` (stdout + stderr merged).

## `auth` — talk to a remote host

```bash
agentproto auth login --host wss://guilde.work    # device-flow login → ~/.agentproto/credentials.json
agentproto auth status --host wss://guilde.work   # show expiry
agentproto auth logout --host wss://guilde.work   # forget the token
```

The credential is used automatically by `agentproto serve --connect <host>` to establish the tunnel.

## `workspace` — register spawn targets

Workspaces are slug→path bindings stored in `~/.agentproto/workspaces.json`. The daemon resolves a `workspaceSlug` field to an absolute cwd for `/sessions/agent` and `/sessions/terminal`.

```bash
agentproto workspace add ~/code/my-project --slug my-project
agentproto workspace add ~/code/secret --slug secret --label "Skunkworks"
agentproto workspace list
agentproto workspace use my-project   # mark active
agentproto workspace remove secret
```

The active workspace is what `serve` defaults to when launched with no `--workspace`, and what the daemon falls back to when an HTTP call omits both `cwd` and `workspaceSlug`.

## `serve` — the local daemon

```bash
# Plain local daemon (loopback only). Reads / writes the active workspace.
agentproto serve

# Bind to a specific port + workspace
agentproto serve --port 18790 --workspace ~/code/my-project

# Local + tunnel: cloud host can dispatch spawns through the daemon.
agentproto serve --connect wss://guilde.work/api/v1/agentproto/tunnel

# Light banner + chain into the interactive dashboard (same terminal).
# Quitting the TUI shuts the daemon down too.
agentproto serve --interactive   # alias: -i
```

The dashboard looks roughly like:

```
─ agentproto monitor · http://127.0.0.1:18790 ──── workspace ~/code/proj · uptime 12m ─
SESSIONS (3)                       │ DETAIL
▸ PTY claude-tui   running     12m │   id        sess_a3f8c1b2
   PTY shell-main running      4m  │   name      claude-tui
       hermes-bg  exited      1h   │   kind      terminal (pty)
                                    │   status    running
                                    │   workspace my-app
                                    │   command   claude
                                    │   pid       12345
                                    │   started   12m ago
                                    │   last out  3s ago
                                    │
                                    │   Enter to attach
─ events  20:42:01 boot · my-app · 20:43:11 spawn sess_a3f8c1b2 ──────────────────────
  ↑/↓ select · Enter attach · K kill · d forget · r refresh · q quit
```

What `serve` exposes:

| Surface           | URL                                       | Notes                                                  |
|-------------------|-------------------------------------------|--------------------------------------------------------|
| Health            | `GET /health`                             | Workspace + uptime — always public                     |
| Events (SSE)      | `GET /events`                             | RuntimeEvents stream                                   |
| MCP               | `POST /mcp` (Streamable HTTP)             | Adapter spawn, terminal sessions, fs/exec, …          |
| Adapter discovery | `GET /adapters`                           | Globally-installed `@agentproto/adapter-*` packages    |
| Sessions (list)   | `GET /sessions` / `GET /sessions/:id`     | id-or-name in `:id`                                   |
| Agent spawn       | `POST /sessions/agent`                    | Long-lived ACP agent (multi-turn)                     |
| Interrupt turn    | `POST /sessions/:id/interrupt`            | Cancel the in-flight turn and leave the session alive |
| Terminal input    | `POST /sessions/:id/terminal/input`       | Write raw input into a live PTY session               |
| Rename session    | `PATCH /sessions/:id`                     | Set or clear the session's user-facing `title`/`label`|
| **PTY spawn**     | **`POST /sessions/terminal`**             | Real PTY under node-pty (alt-screen, ANSI, raw input) |
| **PTY attach**    | **`WS /sessions/:id/pty`**                | JSON-framed duplex; multi-subscriber                  |
| SSE attach        | `GET /sessions/:id/stream`                | Line-by-line text events                              |
| Kill              | `POST /sessions/:id/kill`                 | SIGTERM the underlying child                          |

### Discovery + token

At boot the daemon writes `<workspace>/.agentproto/runtime.json` (mode `0600`) **and** registers itself in the central registry `~/.agentproto/daemons/<port>.json` with:

```json
{
  "workspace": "/abs/path",
  "port": 18790,
  "bind": "127.0.0.1",
  "pid": 12345,
  "startedAt": "2026-05-13T…",
  "name": "agentproto-serve",
  "registered": [],
  "token": "<random-uuid>"
}
```

The CLI does **not** just read one fixed file — `discoverDaemon()` (`src/commands/_daemon-helpers.ts`) walks candidates in this order and takes the **first one that's actually live**:

1. **`AGENTPROTO_DAEMON_URL`** env override. If `AGENTPROTO_DAEMON_TOKEN` isn't also set, the CLI still searches every registered workspace's `runtime.json` for one whose URL matches, so mutating routes don't 401 just because the token wasn't forwarded.
2. **`~/.agentproto/runtime.json`** — an explicit, hand-placed or previously-written file — but only if its `pid` is still alive (`process.kill(pid, 0)`). This is the file most docs (and older `--help` text) call out as *the* discovery mechanism; it's really just the second-highest-priority candidate, and a dead one is skipped rather than trusted.
3. The **central registry**, `~/.agentproto/daemons/<port>.json`, preferring the entry whose port matches `config.json`'s declared `daemon.port` (default `18790`) over any other live entry — a short-lived transient runtime on a random port must not shadow the long-running `serve` daemon.
4. Each configured workspace's own `<workspace>/.agentproto/runtime.json`, in `workspaces.json` order.

A candidate whose `pid` is dead is never trusted — it's recorded as `stale` and discovery moves to the next one. This matters because a `runtime.json` **outlives an unclean shutdown**: `kill -9`, a crash, or a reboot all leave the file behind with a now-invalid token, and it can sit anywhere a daemon was ever started from (including `~` itself, if `agentproto serve` was ever run without `--workspace` from the home directory). `agentproto serve` also sweeps dead-PID `runtime.json` files for every *registered* workspace and the central registry at boot — but a stray file under a workspace that was never registered (e.g. `~` used as an ad-hoc workspace) isn't swept, so it can linger indefinitely; the pid-liveness check in `discoverDaemon()` is what actually keeps it harmless.

- The token from whichever descriptor wins is required on **mutating** `/sessions/*` routes and the `/sessions/:id/pty` WebSocket upgrade. There is **no loopback bypass** — the threat we're defending against (a browser fetch from a localhost-loaded page) is itself on loopback. A browser can't read `runtime.json` (mode 0600); a same-user CLI can.
- Override via env: `AGENTPROTO_DAEMON_URL=http://… AGENTPROTO_DAEMON_TOKEN=…`.
- Read routes (`GET /sessions`, SSE `/stream`) stay open so existing read-only tooling keeps working.

**Known limitation — the restart handoff window.** `pid` liveness is not the same as *token* liveness. For the few seconds right after `agentproto serve` is restarted, the **previous** daemon process can still be alive (mid-shutdown) with its now-superseded token, while a fresher descriptor for the new process hasn't been written yet. `discoverDaemon()` will validly pick the old-but-still-alive candidate and the daemon will answer `401 sessions_unauthorized`. This is a narrow race, not silent: the CLI's `explain401()` helper probes the resolved URL's `/health`, reports which file the rejected token came from, and — since the daemon *is* reachable — tells you it's a token mismatch rather than printing a bare 401. The workaround is the same env override as above, pointed at the file `explain401()` names in its output — typically the central registry entry for the daemon's port:

```bash
export AGENTPROTO_DAEMON_TOKEN=$(node -p "require('$HOME/.agentproto/daemons/18790.json').token")
export AGENTPROTO_DAEMON_URL=http://127.0.0.1:18790
```

It resolves itself once the old process finishes exiting and the stale descriptor's `pid` check starts failing.

### Gateway auth (persistent bearer token)

By default the gateway itself is open on loopback (`mode: "none"`) — the `runtime.json` token above only gates the CLI's own discovery flow. The `remote_enable` MCP tool can flip the whole gateway into `mode: "bearer"`, but it always mints a fresh random token and opens a Cloudflare quick tunnel; the token lives in memory and is lost on every restart.

For a **stable** token that survives restarts and doesn't require a tunnel, set `daemon.authToken` before booting:

```bash
agentproto config set daemon.authToken $(openssl rand -hex 32)
agentproto serve
```

or pass it inline for a one-off run:

```bash
agentproto serve --auth-token <token>
```

`--auth-token` overrides `daemon.authToken` when both are set. This is a separate gate from the per-boot `runtime.json` token above: it covers `/mcp`, `/events`, `/conversations*`, and the heartbeat tick route, and (unlike the `/sessions/*` gate) it DOES exempt loopback callers with no `X-Forwarded-For` header — a tunnel in front of the daemon always sets that header, so a request that truly never left the machine still gets through unauthenticated. Unset, behavior is unchanged: fully open. If `remote_enable` is later called on top, its ephemeral token takes precedence over `daemon.authToken` for as long as the remote tunnel is up.

## `sessions` — browse + control the daemon

```bash
# One-shot table of live + recent sessions
agentproto sessions

# Interactive dashboard — 3 panes + live events ticker
agentproto sessions --watch
#   ↑/↓ or j/k   move selection in the sidebar
#   Enter         attach to selected (PTY-aware)
#   K             SIGTERM selected session
#   d             forget selected (must be exited)
#   r             refresh now
#   q or Ctrl-C   quit
#
# Flat-table version for piping into a pager or grep:
agentproto sessions --watch --simple

# Attach to a specific session (id or name) — full duplex
agentproto sessions --attach claude-tui

# Mirror — read-only tail, never takes stdin, Ctrl-C exits cleanly
# (great when your terminal emulator eats the Ctrl-] q detach chord)
agentproto sessions mirror claude-tui

# Spawn an agent CLI (ACP, structured events)
agentproto sessions start claude-code --workspace my-app --attach
agentproto sessions start claude-code --workspace my-app --title "payments refactor" --attach
agentproto sessions start hermes --label "ops on-call"

# Spawn a real PTY (raw bytes, ANSI escapes, alt-screen apps)
agentproto sessions terminal --name claude-tui --attach -- claude
agentproto sessions terminal --name shell --cwd /tmp -- bash -l
agentproto sessions terminal --name htop --workspace my-project -- htop

# Stop by id or name
agentproto sessions stop claude-tui
```

**Flag conventions for `sessions terminal`:** verb flags come **before** `--`; everything after `--` is argv passed verbatim to the spawned binary. So `--name my-shell -- bash --login` sets the session name and runs `bash --login`. The leading `--` is optional when no argv flag collides with verb flags.

### Attach modes

`agentproto sessions --attach <id-or-name>` fetches the descriptor first and switches transport based on `desc.pty`:

| Verb / kind                 | Transport            | Stdin → child | Resize | Detach           |
|-----------------------------|----------------------|---------------|--------|------------------|
| `--attach` to PTY           | WebSocket `/pty`     | raw bytes ✓   | ✓      | `Ctrl-] q` chord |
| `mirror` to PTY             | WebSocket `/pty`     | **no** (read-only) | no | `Ctrl-C`         |
| `--attach` to agent-cli     | SSE `/stream`        | n/a (use `agent_prompt` MCP tool) | n/a | `Ctrl-C`        |
| `--attach` to command/piped | SSE `/stream`        | n/a           | n/a    | `Ctrl-C`         |

**When to pick which:**
- **`--attach`** — you want to TYPE into the session (drive claude, run bash commands, etc.). Duplex, takes over stdin, you detach with the `Ctrl-] q` chord.
- **`mirror`** — you want to WATCH without interfering, OR your terminal swallows `Ctrl-] q`. Read-only, `Ctrl-C` exits cleanly. The session keeps running on the daemon.

**Detach chord (PTY only):** `Ctrl-]` then `q` closes the WebSocket and exits the CLI; the session keeps running on the daemon. Re-attach later with `agentproto sessions --attach <id-or-name>`. Multiple clients (CLI + xterm.js web panel + another CLI) can attach to the same session simultaneously — the daemon fans bytes out and merges input.

## MCP tools

When `agentproto serve` is up, the gateway's `/mcp` endpoint exposes these tools (call from a Mastra agent, Claude Code as sub-agent, Cursor MCP client, …):

| Tool                          | Purpose                                                   |
|-------------------------------|-----------------------------------------------------------|
| **`session_list`**            | List sessions with `kind` / `status` / `onlyAlive` filters (canonical lister) |
| `agent_sessions_list`         | Agent-only view; use `session_list` with `kind` for full control |
| `agent_start`                 | Spawn a long-lived ACP adapter (claude-code/hermes/…)     |
| `agent_prompt`                | Send a follow-up turn to a live agent session             |
| `agent_output`                | Tail the recent ring buffer (lines)                       |
| `agent_kill`                  | SIGTERM an agent session                                  |
| `agent_interrupt`             | Cancel the in-flight turn without killing the session     |
| `conversation_read`           | Read the provider-native conversation behind any session  |
| **`terminal_start`**          | Spawn a PTY-backed process (any argv)                     |
| **`terminal_input`**          | Send keystrokes to a PTY's stdin                          |
| **`terminal_output`**         | Snapshot the recent byte buffer (base64)                  |
| **`terminal_kill`**           | SIGTERM a PTY session                                     |
| `session_rename`              | Set or clear a session's user-facing `title`/`label`      |
| `adapter_list`                | Enumerate installed `@agentproto/adapter-*` packages      |
| `mcp_discovered_list`         | MCP servers configured in claude / cursor / goose         |
| `mcp_imported_list`           | The user's curated MCP set                                |
| `mcp_import` / `mcp_imported_remove` | Curate the set                                     |
| `mcp_imported_status`         | Connection status of every imported MCP                   |
| `mcp_imported_tool_list` / `mcp_imported_call` | Proxy the imported MCP's tools         |
| `app_install` / `app_run` / `app_list` / `app_status` / `app_stop` | Install and run `@agentproto/app-kit` apps as live sessions |
| `app_apply` / `app_unapply` / `app_list_applied` | Mount / unmount apps to scopes with dependency validation |

The terminal tools let one agent **orchestrate** other sessions: an agent in a structured ACP session can call `terminal_start({argv: ["bash"]})`, then drive it turn-by-turn with `terminal_input` + `terminal_output`. Same surface backs the future `wire`/`tee` primitive for cross-session piping.

## Adapter resolution

`<slug>` resolves to the npm package `@agentproto/adapter-<slug>`. Install adapters globally so `agentproto` can find them on its `NODE_PATH`. First-party adapters shipped today include:

- `@agentproto/adapter-claude-code` — Anthropic Claude Code (protocol: ACP, structured events)
- `@agentproto/adapter-claude-sdk` — Anthropic Claude Agent SDK
- `@agentproto/adapter-codex` — OpenAI Codex
- `@agentproto/adapter-gemini` — Google Gemini CLI (`gemini --experimental-acp`)
- `@agentproto/adapter-hermes` — Hermes (protocol: ACP)
- `@agentproto/adapter-opencode` — OpenCode
- `@agentproto/adapter-openclaw` — OpenClaw
- `@agentproto/adapter-antigravity` — Google Antigravity (`agy`, print/headless, multi-model)
- `@agentproto/adapter-mastra` / `adapter-mastra-agent` / `adapter-mastracode` / `adapter-mastracode-inprocess` — Mastra-based agents
- `@agentproto/adapter-browser` — browser / CDP session adapter
- `@agentproto/adapter-pi` — pi

Use `agentproto sessions terminal -- claude` (or `-- hermes`, `-- aider`, …) when you want the **raw interactive TUI** instead of the structured ACP event stream.

## License

MIT — see [LICENSE](./LICENSE).
