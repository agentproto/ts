# `agentproto mcp-bridge`

```text
agentproto mcp-bridge [--import <alias|importId>]
```

A stdio MCP server that proxies to the daemon's HTTP `/mcp` orchestration
endpoint. Stdio-only MCP clients (Codex, Cursor, Claude Desktop, Hermes)
can use AgentProto's orchestration tools through this bridge — no
third-party bridge needed.

## `--import <alias|importId>`: one imported MCP server

By default the bridge proxies `/mcp` — every orchestration tool.
`--import <alias|importId>` dials `/mcp/imported/<alias|importId>` instead:
the stdio client sees ONE imported MCP server (for example `bureau`) under
its own native tool names, not the daemon's orchestration tools. The daemon
accepts the alias or the import id; same auth and caller identity as
`/mcp`. `--import` cannot be combined with `--surface` (exit `2`), and its
value must be letters, digits, `.` `_` `:` `-`.

```json
{
  "mcpServers": {
    "bureau": {
      "command": "agentproto",
      "args": ["mcp-bridge", "--import", "bureau"]
    }
  }
}
```

[`install-mcp --import`](./install-mcp.md#--import-alias-scoped-registration-for-one-imported-mcp-server)
writes such an entry for you.

The bridge connects to the daemon over HTTP (Streamable HTTP transport),
pulls the tool list once at startup, then passes `listTools`, `callTool`,
`resources/list`, `resources/read`, and `resources/templates/list`
requests through. Tool JSON schemas are forwarded intact so
clients see the real parameter names and types.

## Codex Desktop conversation identity

When a tool call carries Codex thread metadata, the bridge connects that call
as `/mcp?callerSessionId=codex:<thread-id>&host=codex`. The daemon registers an
external session for that chat, so `session_follow` can default its follower
without the model choosing a session id. The bridge reads the metadata on
every call and uses a separate request-local connection; concurrent chats do
not share a last-seen identity. Existing `callerSessionId` URLs take precedence.

Recognized metadata includes `_meta["x-codex-turn-metadata"]` (an object or JSON
string containing `thread_id`), `openai/threadId`, `openai/thread_id`,
`codexThreadId`, `codex_thread_id`, `threadId`, `thread_id`, and `thread.id`.
These are host-supplied MCP metadata, outside the tool's arguments. A host
must identify itself as Codex to use the generic thread aliases; namespaced
Codex/OpenAI metadata also works with a generic handshake name. A host
that does not attach them must be updated to do so. The bridge never derives
conversation identity from `clientInfo.name`, a process-wide `CODEX_THREAD_ID`,
or an old agentproto session id.

Identity alone provides inbox delivery. By default `session_follow` reports
`delivery: { mode: "external-inbox", wakesFollower: false, ... }`.
For allowlisted local chats, the daemon can use
[experimental Codex Desktop wake](../guides/session-follow.md#experimental-local-codex-desktop-wake)
to request a notification turn from Desktop.

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `AGENTPROTO_MCP_URL` | `http://127.0.0.1:<daemon.port>/mcp` | Daemon `/mcp` endpoint. |

The default port is read from `~/.agentproto/config.json` →
`daemon.port` (default `18790`). Set `AGENTPROTO_MCP_URL` explicitly if
the daemon runs on a non-standard port.

## Registering in a stdio MCP client

```json
{
  "mcpServers": {
    "agentproto": {
      "command": "agentproto",
      "args": ["mcp-bridge"],
      "env": {
        "AGENTPROTO_MCP_URL": "http://127.0.0.1:18790/mcp"
      }
    }
  }
}
```

For Claude Desktop this goes in `~/Library/Application
Support/Claude/claude_desktop_config.json` (macOS) or the equivalent
config path on other platforms.

For Codex, Cursor, and Hermes, configure the MCP server entry in their
respective settings using the same shape.

## Startup

```text
agentproto mcp-bridge: AGENTPROTO_MCP_URL not set, using http://127.0.0.1:18790/mcp
agentproto mcp-bridge: connected to http://127.0.0.1:18790/mcp, proxying 12 tool(s) over stdio
```

The process parks forever — `StdioServerTransport` stays alive until
stdin closes or the process is killed. The tool count in the startup
message reflects the daemon's current tool set; if the daemon restarts,
restart the bridge too.

## Errors

If the daemon is not running:

```text
agentproto mcp-bridge: failed to connect to daemon at http://127.0.0.1:18790/mcp —
  Connection refused. Is the daemon running? Start it: agentproto serve
```

## Examples

```bash
# Default: reads daemon.port from config, connects to localhost
agentproto mcp-bridge

# Explicit URL for a non-standard port
AGENTPROTO_MCP_URL=http://127.0.0.1:18791/mcp agentproto mcp-bridge
```

## See also

- [`serve.md`](./serve.md) — the daemon that serves `/mcp`
- [`daemon.md`](./daemon.md) — managed background daemon
- [MCP in coding CLIs guide](../guides/mcp-in-coding-cli.md) — end-to-end setup
