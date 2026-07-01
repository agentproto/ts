---
name: agentproto
description:
  Operate the agentproto daemon — spawn agent sessions (claude-code,
  hermes, …), drive imported MCP tools through the proxy, manage PTY
  terminals, and control the optional cloud tunnel. Use when a task needs
  to start / check / troubleshoot the runtime, drive a long-lived agent
  session, or author tools/drivers in @agentproto/*.
metadata:
  tags: agentproto, daemon, mcp, sessions, tunnel, adapters, agent-cli
---

## When to use

- Start / check / troubleshoot the agentproto daemon.
- Spawn or continue a multi-turn agent session (`start_agent_session`,
  `prompt_agent_session`).
- Drive imported MCP tools proxied through the daemon (`mcp_imported_call`).
- Diagnose why `mcp__agentproto__*` tools are missing from a client session.
- Author or extend a tool/driver in `@agentproto/driver-agent-cli`.

## Daemon vs tunnel — which to run

| What you need | What to run |
|---|---|
| Local-only: Claude Code (or another same-machine client) drives sessions | `agentproto serve` — daemon only, loopback |
| Cloud / remote clients need the daemon (web app, mobile, another machine) | `agentproto serve --connect wss://<host>/api/v1/agentproto/tunnel` |

The tunnel is an outbound WebSocket from your machine to the host. Remote
operators drive local spawns through it. Without it, the daemon is reachable
only at `127.0.0.1:<port>`.

## Health check + startup

```bash
# 1. Is it up?
curl -s http://127.0.0.1:18790/health
# → {"status":"ok","workspace":"…","uptimeMs":…}

# Note: when daemon.port is set to a non-default value (e.g. 18791),
# adjust the port in the URL above. /health is always authoritative;
# runtime.json may not exist for all launch configurations.

# 2. If dead, start it:
agentproto serve &                        # foreground, local only
agentproto daemon start                   # if installed as a launchd/systemd service
# Or with tunnel:
agentproto serve --connect wss://<host>/api/v1/agentproto/tunnel

# 3. After daemon is up, reconnect the MCP client:
#    Claude Desktop / Cursor / Claude Code → disconnect and reconnect
#    the agentproto server in settings. The mcp__agentproto__* tools
#    reappear once reconnected.

# 4. Adapters not resolving?
agentproto install claude-code            # re-install the adapter
agentproto install hermes
agentproto sessions start claude-code --workspace my-project
```

## MCP bridge for Claude Desktop

The daemon exposes an MCP endpoint at `POST /mcp`. To use it from Claude
Desktop, add a stdio bridge in `claude_desktop_config.json`:

```json
"agentproto": {
  "command": "node",
  "args": ["/path/to/@agentproto/cli/apps/mcp-bridge.mjs"],
  "env": {
    "AGENTPROTO_MCP_URL": "http://127.0.0.1:18790/mcp"
  }
}
```

**Port gotcha:** if `daemon.port` in your `~/.agentproto/config.json` is not
`18790` (the default), set `AGENTPROTO_MCP_URL` to match. Without it the
bridge silently connects to the wrong port and the tools don't appear.

```bash
# Check your configured port:
agentproto config get daemon.port
# → 18791

# Then update AGENTPROTO_MCP_URL in claude_desktop_config.json:
# "AGENTPROTO_MCP_URL": "http://127.0.0.1:18791/mcp"
```

After editing `claude_desktop_config.json`, restart Claude Desktop.

## Adapters

| Slug | Protocol | When to pick |
|------|----------|-------------|
| `claude-code` | acp | Long-lived ACP process via `@agentclientprotocol/claude-agent-acp`. Bidirectional, multimodal. Best for extended interactive sessions. |
| `claude-code-print` | print | `claude -p --output-format stream-json` — one subprocess per turn, no ACP wrapper, no stale-proxy race. Session continuity via `--resume`. ~200–400 ms cold-start per turn. Simpler and more reliable. |
| `hermes` | acp | Hermes via ACP. |
| `mastra-agent` | acp | First-party agent — an AIP-42 `AGENT.md` run as a live Mastra agent (our loop, our models, routed from the spawn env). SQLite memory + workspace tools. Standalone via `agentproto-mastra acp`. |
| `opencode` / `codex` / `openclaw` | acp / proprietary | Various. |

```bash
agentproto install claude-code            # idempotent (skips if already installed)
agentproto install claude-code --force    # reinstall regardless

# One-shot turn
agentproto run claude-code --cwd . --prompt "summarise this repo"
agentproto run claude-code-print --cwd . --prompt "summarise this repo"
```

**Resolver parent-package fallback:** slug `claude-code-print` resolves via
`@agentproto/adapter-claude-code` (the `claudeCodePrint` named export). No
separate npm package is needed for variant adapters exported from the same
package.

## MCP tools reference

These appear as `mcp__agentproto__*` (or whatever alias your client uses) when
the daemon is connected.

**Sessions — agents:**

| Tool | Purpose |
|------|---------|
| `list_adapters` | Installed `@agentproto/adapter-*` slugs |
| `start_agent_session { adapter, cwd?, prompt?, label?, model? }` | Spawn a long-lived agent session → `{ sessionId }` |
| `prompt_agent_session { sessionId, prompt }` | Follow-up turn (queued if session is mid-turn) |
| `get_agent_session_output { sessionId, since?, lastN?, waitForTurnEnd?, timeoutMs? }` | Incremental cursor read; long-poll until turn ends |
| `kill_agent_session { sessionId }` | SIGTERM the session |
| `list_sessions { kind?, onlyAlive?, status? }` | All sessions |

**`get_agent_session_output` cursor pattern (eliminates polling):**
```
# First call — get initial context + seed cursor
out = get_agent_session_output { sessionId, lastN: 20 }
cursor = out.nextCursor

# Send prompt, then long-poll for turn end
prompt_agent_session { sessionId, prompt: "..." }
out = get_agent_session_output { sessionId, since: cursor, waitForTurnEnd: true }
# out.lines contains only the new lines from that turn
cursor = out.nextCursor

# Repeat — only new lines, no repeated context
```

**Sessions — PTY terminals:**

| Tool | Purpose |
|------|---------|
| `start_terminal_session { argv, cwd?, cols?, rows?, name? }` | PTY-backed process |
| `write_terminal_input { sessionId, text }` | Send keystrokes |
| `read_terminal_output { sessionId, lastBytes? }` | Snapshot (base64) |
| `kill_terminal_session { sessionId }` | SIGTERM |

**Tunnel:**

| Tool | Purpose |
|------|---------|
| `remote_enable { provider?, targetPort? }` | Open tunnel → `{ url, token }` |
| `remote_disable` | Close tunnel |
| `remote_status` | Tunnel health |

**Imported MCP proxy:**

| Tool | Purpose |
|------|---------|
| `mcp_imported_status` | Health of every imported alias |
| `list_imported_mcps` / `list_discovered_mcps` | Available MCPs |
| `import_mcp { sourceMcpId, alias? }` / `remove_imported_mcp { id }` | Curate |
| `mcp_imported_list_tools { alias }` | Tool list from an alias |
| `mcp_imported_call { alias, toolName, args? }` | Invoke a proxied tool |

**Filesystem (workspace-scoped):**

`read_file`, `write_file`, `list_directory`, `create_directory`, `delete_file`, `get_file_info`

**Shell (allowlist-gated):**

| Tool | Purpose |
|------|---------|
| `execute_command { command, args?, cwd?, stdin?, timeoutMs?, async? }` | Sync by default; `async: true` → returns `{ commandId }` immediately |
| `get_command_output { commandId }` | Poll stdout/stderr/status of an async command |
| `cancel_command { commandId }` | SIGTERM a running async command |

**Async pattern for long commands (builds, `claude -p`, tests):**
```
# Start without blocking MCP transport
r = execute_command { command: "pnpm", args: ["test"], async: true }
commandId = r.commandId

# Poll until done
loop:
  out = get_command_output { commandId }
  if out.status != "running": break
  sleep 3s

# Result available
out.exitCode, out.stdout, out.stderr

# Or cancel if needed
cancel_command { commandId }
```

**Allowlist setup (if execute_command is blocked):**
```bash
# Dev preset — one-liner:
echo '{"version":1,"commands":["claude","gh","pnpm","node","git","npx"]}' > .agentproto/allowed-commands.json
```

## ToolSearch note

The daemon's session tools are **deferred** in Claude Code. Keyword search
finds nothing — use exact-name `select:`:

```
ToolSearch("select:mcp__agentproto__agent_start,mcp__agentproto__session_list,mcp__agentproto__agent_output,mcp__agentproto__agent_prompt")
```

## Recovery playbook

**"list_adapters returns empty"** — daemon was restarted but adapters weren't
re-installed on the global `NODE_PATH`:
```bash
agentproto install claude-code
agentproto install hermes    # if needed
```

**"mcp__agentproto__* tools missing from session"** — MCP bridge disconnected:
1. Verify daemon: `curl -s http://127.0.0.1:<port>/health`
2. If dead: `agentproto serve &` or `agentproto daemon start`
3. Reconnect the server in Claude Desktop / Cursor settings

**"bridge connects but tools still empty"** — port mismatch:
```bash
agentproto config get daemon.port     # e.g. 18791
# Update AGENTPROTO_MCP_URL in claude_desktop_config.json to match
```

## CLI quick reference

```bash
agentproto auth      <login|status|logout>       authenticate against a remote host
agentproto config    <show|get|set|unset|edit>   ~/.agentproto/config.json
agentproto daemon    <install|uninstall|start|stop|status|logs>  OS service management
agentproto install   <slug>                      install an adapter's underlying CLI
agentproto setup     <slug>                      re-run adapter setup (idempotent)
agentproto run       <slug> --cwd . --prompt …   one-shot turn, exit
agentproto serve     [--connect <wss>]           long-running daemon (HTTP+MCP+sessions)
agentproto workspace <add|list|remove|use>       register spawn directories
agentproto sessions  [...]                       browse + control live sessions
```

## Safety rails

The daemon executes shell commands gated by `.agentproto/allowed-commands.json`
and can drive imported tools that act as the user (browser, social, payments).
- Confirm before anything that posts, pays, sends, or deletes.
- `runtime.json`, `credentials.json`, `remote.json` carry auth tokens — never
  print or commit them.
- Don't kill the daemon casually if remote clients are attached — check
  `GET /sessions` first.