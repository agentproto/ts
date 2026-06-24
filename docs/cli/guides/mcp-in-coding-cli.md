# Use agentproto as an MCP server inside coding CLIs

This guide covers **one direction**: registering the agentproto daemon as an
MCP server *inside* an external coding CLI (Claude Code, Codex, Hermes) so
the CLI's agent can call agentproto tools — spawn sessions, prompt them, poll
events, and orchestrate multi-agent swarms — from within its own tool loop.

> **The other direction** (host → agentproto) is different: installing
> `claude-code`, `codex`, or `hermes` as *adapters* inside agentproto so the
> daemon can spawn and drive them. That uses `agentproto install <slug>` and
> is documented in [concepts/adapters.md](../concepts/adapters.md). The `codex`
> adapter is listed in the catalog (`@agentproto/adapter-codex`) but is **not
> yet published to npm** — installation will fail until the package is released.

---

## Prerequisites

| Requirement | Details |
|-------------|---------|
| Node.js | ≥ 20.9.0 |
| `@agentproto/cli` | `npm i -g @agentproto/cli` |
| Target CLI installed | Claude Code, Codex, or Hermes — see each section |

## Step 1 — Start the daemon

The daemon exposes an HTTP MCP endpoint at `http://127.0.0.1:18790/mcp` (MCP
Streamable HTTP transport, stateless per-request).

```bash
agentproto serve
# or pin a workspace:
agentproto serve --workspace ~/code/my-project --port 18790
```

On boot the daemon writes `<workspace>/.agentproto/runtime.json` (mode 0600)
with the live port and a per-boot bearer token.  **You do not need to pass a
token for MCP tool calls from localhost** — the origin allowlist covers
`127.0.0.1:*` and `localhost:*` by default.  The bearer token is only required
for mutating HTTP routes (`POST /sessions/*`, `DELETE /sessions/*`, WS PTY
upgrade) called from a non-localhost origin.

To run the daemon as a background OS service instead, see
[`agentproto daemon`](../verbs/daemon.md).

### Smoke-test the endpoint

```bash
curl -s http://127.0.0.1:18790/health | python3 -m json.tool
# → { "status": "ok", "workspace": "...", "registered": [...], "uptime": ... }
```

---

## Step 2 — Register in the coding CLI

agentproto speaks two MCP transports:

- **HTTP** (`http://127.0.0.1:18790/mcp`) — use directly from clients that support MCP Streamable HTTP (Claude Code).
- **stdio** via the bundled **`agentproto mcp-bridge`** command — a stdio MCP server that proxies the daemon `/mcp` and **forwards the real tool schemas**. Use it for stdio-only clients (Codex, Cursor, Claude Desktop, standalone Hermes); no third-party bridge needed.

```bash
# stdio entrypoint — same daemon, any stdio MCP client:
agentproto mcp-bridge
# honours AGENTPROTO_MCP_URL (default http://127.0.0.1:18790/mcp);
# set it if daemon.port differs from 18790.
```

### Claude Code

Claude Code supports the MCP Streamable HTTP transport natively.

**Option A — project `.mcp.json`** (checked into the repo, applies to all
contributors):

```json
{
  "mcpServers": {
    "agentproto": {
      "type": "http",
      "url": "http://127.0.0.1:18790/mcp"
    }
  }
}
```

Place this file at the project root.  Claude Code picks it up automatically
when launched from that directory.  This is the exact entry used in the
agentproto repo's own root `.mcp.json`.

**Option B — `claude mcp add` (global or project scope)**:

```bash
# Project scope (writes to .mcp.json):
claude mcp add --transport http agentproto http://127.0.0.1:18790/mcp

# User scope (writes to ~/.claude.json); flag name may be --scope user:
claude mcp add --transport http --scope user agentproto http://127.0.0.1:18790/mcp
```

After registration, restart the Claude Code session.  The `agentproto` server
will appear in the MCP panel and its tools are immediately available to the
agent.

> **Note**: The `.mcp.json` snippet is verified from the repo's root config.
> The `claude mcp add` flags above match the published Claude Code reference but
> are not exercised in the agentproto repo — in particular `--scope user`
> (not `--scope global`) is the likely flag for user-level registration; verify
> against your installed version.

---

### Codex (`@openai/codex` CLI)

OpenAI's Codex CLI registers stdio MCP servers via `~/.codex/config.toml`.
Codex's MCP client speaks **stdio**, so point it at agentproto's bundled
`mcp-bridge` — no third-party proxy needed:

```toml
# ~/.codex/config.toml
[mcp_servers.agentproto]
command = "agentproto"
args    = ["mcp-bridge"]
# non-default daemon port? pass it through:
# env = { AGENTPROTO_MCP_URL = "http://127.0.0.1:18791/mcp" }
```

`agentproto mcp-bridge` is a stdio MCP server that relays to the daemon `/mcp`
and forwards each tool's real input schema — so Codex's agent sees the actual
tool parameters, not an opaque blob.

> **⚠ Verify** the `~/.codex/config.toml` key names against your installed
> `@openai/codex` version. The `mcp-bridge` command ships in `@agentproto/cli`;
> if `agentproto` isn't on `$PATH`, use `command = "node"` with
> `args = ["/path/to/@agentproto/cli/dist/cli.mjs", "mcp-bridge"]`.

---

### Hermes (`hermes` CLI)

Hermes ships its own ACP server (`hermes acp`) and accepts MCP servers
injected at session spawn time via the ACP `session/new.mcpServers` parameter.
There is no standalone static config file for Hermes to pre-register MCP
servers before a session starts.

**When launched via agentproto** (recommended): agentproto automatically
injects its orchestrator MCP gateway into every Hermes session it spawns — no
manual config needed.  See [`agentproto sessions start hermes`](../verbs/sessions.md).

**When launched standalone via the ACP client**: include the MCP server in the
`session/new` call:

```json
{
  "cwd": "/path/to/workspace",
  "mcpServers": [
    {
      "name": "agentproto",
      "type": "http",
      "url": "http://127.0.0.1:18790/mcp"
    }
  ]
}
```

Hermes propagates the `mcpServers` list to its internal tool registry for the
duration of the session.

> **⚠ Unverified**: whether a standalone Hermes CLI config file (e.g.
> `~/.hermes/config.yaml`) pre-registers MCP servers before session start was
> not confirmed from the agentproto repo.  The ACP `session/new.mcpServers`
> injection is the verified mechanism.

---

## Step 3 — Verify

Once the daemon is running and the CLI is registered, confirm tools are
visible.

**From Claude Code** — type `/mcp` in the chat input; agentproto should appear
in the server list.  Or prompt the agent: `List the MCP tools available from
agentproto`.

**Direct MCP tool call** (from any client) — list all sessions:

```text
Tool: list_sessions
Input: {}
```

Expected response: an array (possibly empty) of sessions.  Use
`list_agent_sessions` to filter to agent-only sessions.

**Raw curl smoke test**:

```bash
curl -s -X POST http://127.0.0.1:18790/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | python3 -m json.tool | grep '"name"' | head -20
```

Expected: tool names including `start_agent_session`, `list_sessions`,
`prompt_agent_session`, and others.

---

## What agentproto exposes over MCP

The full daemon tool surface is available at `/mcp`.  Key tools for
coding-CLI orchestration:

| Tool | Purpose |
|------|---------|
| `start_agent_session` | Spawn a new adapter session (claude-code, hermes, opencode, …) |
| `prompt_agent_session` | Send a turn to a running session |
| `get_agent_session_output` | Read a session's output |
| `list_sessions` | List all sessions (agent + terminal + browser) |
| `list_agent_sessions` | List active agent sessions only |
| `kill_agent_session` | Stop a session |
| `session_tree` | Session hierarchy (parent → children) |
| `wait_for_any` | Block until one of a set of sessions completes |
| `poll_events` | Drain runtime events |
| `list_adapters` | List installed adapter CLIs |
| `list_discovered_mcps` | MCPs discovered from other CLIs on this machine |
| `create_tunnel` / `list_tunnels` | Manage reverse tunnels |
| `read_file` / `write_file` / `list_directory` | Workspace filesystem |
| `start_browser` / `stop_browser` | Browser session lifecycle |

For the live tool catalog, call `tools/list` via curl (see verify step above)
or check `GET /health` → `registered[]`.

---

## Scoped gateway (restrict tool access)

To give the coding CLI a narrower tool surface — session management only,
no filesystem or browser tools — use the orchestrator gateway endpoint:

```
http://127.0.0.1:18790/mcp/orchestrator?scope=<token>
```

The orchestrator gateway exposes only session-management and policy tools.
The scoped `<token>` is minted per-child session; it appears in the
`start_agent_session` response.

---

## Gaps and known issues

| Item | Status |
|------|--------|
| `claude mcp add` exact flag syntax | Verify against your claude-code version — not exercised in this repo |
| Codex registration | Native `agentproto mcp-bridge` stdio entrypoint (no `mcp-remote`); verify `~/.codex/config.toml` keys against your version |
| `~/.codex/config.toml` key schema | Verify against your `@openai/codex` version |
| Hermes standalone MCP config file | Unknown; ACP `session/new.mcpServers` is the confirmed path |
| `@agentproto/adapter-codex` npm release | **Not published** — `agentproto install codex` will fail |
| Bearer token for MCP tool calls | Not required from localhost; only for mutating `/sessions/*` from remote origins |
