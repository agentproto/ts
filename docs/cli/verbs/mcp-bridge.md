# `agentproto mcp-bridge`

```text
agentproto mcp-bridge
```

A stdio MCP server that proxies to the daemon's HTTP `/mcp` orchestration
endpoint. Stdio-only MCP clients (Codex, Cursor, Claude Desktop, Hermes)
can use AgentProto's orchestration tools through this bridge — no
third-party bridge needed.

The bridge connects to the daemon over HTTP (Streamable HTTP transport),
pulls the tool list once at startup, then passes `listTools`, `callTool`,
`resources/list`, `resources/read`, and `resources/templates/list`
requests through verbatim. Tool JSON schemas are forwarded intact so
clients see the real parameter names and types.

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