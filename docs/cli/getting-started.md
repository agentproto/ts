# Getting started

One verified path from `npm install` to a project-scoped Claude Code
integration: install → workspace → daemon → register the MCP server →
verify → skills.

> Looking for the other direction — agentproto **driving** Claude Code,
> Codex, or Hermes as an adapter instead of being called by them — see
> [`verbs/install.md`](./verbs/install.md) and
> [`verbs/run.md`](./verbs/run.md). This walkthrough is: your existing
> coding CLI calls **into** agentproto over MCP.

## 1. Install the CLI

```bash
npm i -g @agentproto/cli
agentproto --version
```

Requires Node.js ≥ 20.9.0. The binary is named `agentproto`; `--help`
(no args, or `-h`) prints the full verb list.

## 2. Register your workspace

A workspace is a registered project directory other verbs can target
by slug instead of by absolute path.

```bash
cd /path/to/your/project
agentproto workspace add . --slug my-project
agentproto workspace list
```

See [`verbs/workspace.md`](./verbs/workspace.md).

## 3. Start the daemon

The daemon boots a local HTTP gateway — sessions, MCP, events — bound
to the workspace you just registered.

```bash
agentproto serve --workspace /path/to/your/project
```

This runs in the foreground (Ctrl-C to stop) — good for a first run.
It writes `<workspace>/.agentproto/runtime.json` with the live port and
a per-boot bearer token; MCP tool calls from `127.0.0.1`/`localhost`
don't need that token, it's only required for mutating HTTP routes
called from a non-localhost origin.

For an always-on background service instead (macOS launchd today), see
[`verbs/daemon.md`](./verbs/daemon.md) — same binary, same flags, just
supervised by the OS.

Leave the daemon running and open a second terminal for the next steps.

## 4. Register the MCP server in Claude Code (project-scoped)

Claude Code speaks the MCP Streamable HTTP transport natively, so it
can call the daemon directly at `http://127.0.0.1:18790/mcp` — no
bridge process needed.

Project scope means the config lives in the repo and applies to every
contributor who opens it in Claude Code. Create `.mcp.json` at the
project root:

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

Adjust the port if you passed `--port` to `serve`. Restart your Claude
Code session — the `agentproto` server appears in its MCP panel and
its tools become available immediately.

For Codex, Cursor, Claude Desktop, or Hermes instead — including a
user-scoped (not project-scoped) Claude Code registration — see the
full guide: [`guides/mcp-in-coding-cli.md`](./guides/mcp-in-coding-cli.md).
`agentproto install-mcp --yes` also automates this step (and the
equivalent for every other coding CLI it detects on the machine) if
you'd rather not hand-write the config.

## 5. Verify — read-only checks

Confirm the daemon is up and the tool surface is reachable before
trusting an agent to use it. Neither command below mutates anything.

```bash
curl -s http://127.0.0.1:18790/health | python3 -m json.tool
# → { "status": "ok", "workspace": "...", "registered": [...], "uptimeMs": ... }
```

```bash
curl -s -X POST http://127.0.0.1:18790/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | grep -o '"name":"[a-z_]*"' | head -20
```

The MCP endpoint uses the Streamable HTTP transport — both
`application/json` and `text/event-stream` must be present in `Accept`
or it responds `406 Not Acceptable`.

From inside Claude Code itself: type `/mcp` in the chat input and
confirm `agentproto` is listed, or just prompt the agent — "List the
MCP tools available from agentproto."

## 6. Install the skill pack

Skills teach the agent how to use the tools you just exposed —
orchestration patterns, session supervision, delegation conventions.

```bash
# Preview what would install, no writes:
agentproto install skill/agentproto-pack --list

# Install it:
agentproto install skill/agentproto-pack
```

Without `--target`, this fans out to every installed adapter that
declares a `metadata.skills` block. See
[`verbs/install.md`](./verbs/install.md#skill-install).

`agentproto onboard --yes` does steps 4 and 6 together in one
non-interactive pass, for every coding CLI it detects — reach for it
once you've done the manual path once and understand what it's doing.

## What's next

- Persistent sessions you can detach + reattach:
  [`verbs/sessions.md`](./verbs/sessions.md)
- Orchestrating a multi-agent swarm from a manifest:
  [`concepts/swarms.md`](./concepts/swarms.md) +
  [`verbs/run-swarm.md`](./verbs/run-swarm.md)
- Gating whether a spawned agent may itself delegate to sub-agents:
  [`concepts/roles.md`](./concepts/roles.md)
- What a session's transcript captures and how to export it:
  [`concepts/session-transcripts.md`](./concepts/session-transcripts.md)
- Hosting your CLI for a remote agent over a tunnel:
  [`verbs/serve.md`](./verbs/serve.md) +
  [`verbs/auth.md`](./verbs/auth.md)
- Driving an adapter directly instead of being called via MCP:
  [`verbs/install.md`](./verbs/install.md) +
  [`verbs/run.md`](./verbs/run.md)
