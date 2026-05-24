# @agentproto/cli

The `agentproto` binary — host for [AIP-45 agent CLIs](https://agentproto.sh/docs/aip-45). Install adapters, run one-shot turns, spawn long-lived sessions, expose them over a tunnel, and drive an interactive PTY from your terminal or a web client.

```bash
npm install -g @agentproto/cli
```

This installs the `agentproto` executable on your `PATH`.

## Verbs

```text
agentproto auth      <login|status|logout>     authenticate against a remote host (Guilde, …)
agentproto config    <show|get|set|unset|edit> read/write ~/.agentproto/config.json
agentproto daemon    <install|uninstall|…>     manage agentproto as a background service (launchd)
agentproto install   <slug>                    install an adapter's underlying CLI
agentproto setup     <slug>                    re-run an adapter's setup steps (idempotent)
agentproto run       <slug>                    spawn the adapter, dispatch one turn, exit
agentproto serve     [--connect <wss>]         long-running local daemon (HTTP + MCP + sessions)
agentproto workspace <add|list|remove|use>     register workspaces the daemon can spawn into
agentproto sessions  [...]                     browse + control live sessions on the daemon
```

`agentproto --help` prints the full usage; `--version` prints the package version.

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

agentproto setup openclaw                   # re-run adapter setup (env keys, login, …)
agentproto setup openclaw --only login      # only specific steps
```

v0.1 implements the `npm` install method; other package managers print a clear "not yet" message and exit non-zero.

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

Schema (all fields optional):

```jsonc
{
  "daemon": {
    "workspace": "/abs/path",                  // default cwd when not passed
    "port": 18790,
    "bind": "127.0.0.1",
    "allowedOrigins": ["https://guilde.work"], // extends localhost defaults
    "strictOrigins": false,                    // when true, drops localhost defaults — only allowedOrigins is honoured
    "label": "jeremy@mbp"
  },
  "tunnel": {
    "host": "wss://guilde.work/api/v1/agentproto/tunnel",
    "autoconnect": false                       // bootstrap with --connect at serve
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
agentproto daemon start                                    # kickstart again
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
| **PTY spawn**     | **`POST /sessions/terminal`**             | Real PTY under node-pty (alt-screen, ANSI, raw input) |
| **PTY attach**    | **`WS /sessions/:id/pty`**                | JSON-framed duplex; multi-subscriber                  |
| SSE attach        | `GET /sessions/:id/stream`                | Line-by-line text events                              |
| Kill              | `POST /sessions/:id/kill`                 | SIGTERM the underlying child                          |

### Discovery + token

At boot the daemon writes `<workspace>/.agentproto/runtime.json` (mode `0600`) with:

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

- The CLI reads this file to find the daemon URL and the bearer token.
- The token is required on **mutating** `/sessions/*` routes and the `/sessions/:id/pty` WebSocket upgrade. There is **no loopback bypass** — the threat we're defending against (a browser fetch from a localhost-loaded page) is itself on loopback. A browser can't read `runtime.json` (mode 0600); a same-user CLI can.
- Override via env: `AGENTPROTO_DAEMON_URL=http://… AGENTPROTO_DAEMON_TOKEN=…`.
- Read routes (`GET /sessions`, SSE `/stream`) stay open so existing read-only tooling keeps working.

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
| `--attach` to agent-cli     | SSE `/stream`        | n/a (use `prompt_agent_session` MCP tool) | n/a | `Ctrl-C`        |
| `--attach` to command/piped | SSE `/stream`        | n/a           | n/a    | `Ctrl-C`         |

**When to pick which:**
- **`--attach`** — you want to TYPE into the session (drive claude, run bash commands, etc.). Duplex, takes over stdin, you detach with the `Ctrl-] q` chord.
- **`mirror`** — you want to WATCH without interfering, OR your terminal swallows `Ctrl-] q`. Read-only, `Ctrl-C` exits cleanly. The session keeps running on the daemon.

**Detach chord (PTY only):** `Ctrl-]` then `q` closes the WebSocket and exits the CLI; the session keeps running on the daemon. Re-attach later with `agentproto sessions --attach <id-or-name>`. Multiple clients (CLI + xterm.js web panel + another CLI) can attach to the same session simultaneously — the daemon fans bytes out and merges input.

## MCP tools

When `agentproto serve` is up, the gateway's `/mcp` endpoint exposes these tools (call from a Mastra agent, Claude Code as sub-agent, Cursor MCP client, …):

| Tool                          | Purpose                                                   |
|-------------------------------|-----------------------------------------------------------|
| **`list_sessions`**           | List sessions with `kind` / `status` / `onlyAlive` filters (canonical lister) |
| `list_agent_sessions`         | Deprecated alias for `list_sessions` (no filters)         |
| `start_agent_session`         | Spawn a long-lived ACP adapter (claude-code/hermes/…)     |
| `prompt_agent_session`        | Send a follow-up turn to a live agent session             |
| `get_agent_session_output`    | Tail the recent ring buffer (lines)                       |
| `kill_agent_session`          | SIGTERM an agent session                                  |
| **`start_terminal_session`**  | Spawn a PTY-backed process (any argv)                     |
| **`write_terminal_input`**    | Send keystrokes to a PTY's stdin                          |
| **`read_terminal_output`**    | Snapshot the recent byte buffer (base64)                  |
| **`kill_terminal_session`**   | SIGTERM a PTY session                                     |
| `list_adapters`               | Enumerate installed `@agentproto/adapter-*` packages      |
| `list_discovered_mcps`        | MCP servers configured in claude / cursor / goose         |
| `list_imported_mcps`          | The user's curated MCP set                                |
| `import_mcp` / `remove_imported_mcp` | Curate the set                                     |
| `mcp_imported_status`         | Connection status of every imported MCP                   |
| `mcp_imported_list_tools` / `mcp_imported_call` | Proxy the imported MCP's tools         |

The terminal tools let one agent **orchestrate** other sessions: an agent in a structured ACP session can call `start_terminal_session({argv: ["bash"]})`, then drive it turn-by-turn with `write_terminal_input` + `read_terminal_output`. Same surface backs the future `wire`/`tee` primitive for cross-session piping.

## Adapter resolution

`<slug>` resolves to the npm package `@agentproto/adapter-<slug>`. Install adapters globally so `agentproto` can find them on its `NODE_PATH`. Built-in adapters as of v0.1:

- `@agentproto/adapter-claude-code` — Anthropic Claude Code via [@agentclientprotocol/claude-agent-acp](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp) (protocol: ACP, structured events)
- `@agentproto/adapter-hermes` — Hermes (protocol: ACP)
- `@agentproto/adapter-openclaw` / `opencode` / `codex` / `mastra` — others discoverable via `GET /adapters` on a live daemon

Use `agentproto sessions terminal -- claude` (or `-- hermes`, `-- aider`, …) when you want the **raw interactive TUI** instead of the structured ACP event stream.

## License

MIT — see [LICENSE](./LICENSE).
