# `agentproto mcp-app`

```text
agentproto mcp-app <appId> [--access read[,write][,approve]]
agentproto mcp-app --http <appDir> [--port N] [--host H] [--tenants <file.json>]
```

A stdio MCP server scoped to ONE installed app's tools — the buyer-facing
distribution path for an app (e.g. a book bundle) that shouldn't hand a
Codex/Cursor/Windsurf client the full daemon `/mcp` gateway (~177 core tools
including `command_execute`, fs, `agent_*`).

Unlike [`mcp-bridge`](./mcp-bridge.md), which proxies every daemon tool
verbatim, `mcp-app` reads the target app's `exposes.tools` off its installed
`APP.md` and registers only those tools. Each call forwards to the daemon's
`POST /apps/:appId/tool-call` route with the tool's ORIGINAL id (the same
allowlist+dispatch path (`performAppToolCall`) the browser bridge
(`agentproto app serve`) and the `app_tool_call` MCP verb already share), so the
allowlist is enforced server-side too, not just by this process's own tool
registration. Design: [`exposes-tools-contract.md`](../../design/exposes-tools-contract.md).

## `exposes.tools`

```yaml
exposes:
  prefix: bureau            # mandatory, [a-z][a-z0-9]{1,15}, no "_"
  tools:
    - id: bureau.status
      access: read          # read | write | approve
      description: Bureau health and the running browser instances.
    - id: imported:bureau/browser_list_instances
      access: read
      mcpName: list_instances   # mandatory for an imported id
      description: List the browser instances.
```

- **Name**: `<prefix>_<name>`, from the single `exposedToolName` function. The
  name is `mcpName` (else the id) without a leading `<prefix>.` or `<prefix>_`,
  with every character outside `[a-zA-Z0-9_-]` replaced by `_`. It is at most
  64 characters and never contains `:` or `/`.
- **Schema**: the tool's real input schema, from `inputSchema` or the bundled
  `TOOL.md` `inputs`. A tool with neither falls back to a free `{ args }` object.
- **Annotations**: `read` tools carry `readOnlyHint`, `write` and `approve`
  tools carry `destructiveHint`.
- **Validation** (at load, and again here): `access: read` is refused on a
  `TOOL.md` that declares `mutates` or a `mutator`/`write` tag; an id or
  `mcpName` starting with `approval` is refused; the prefix cannot be the first
  segment of a daemon tool name (`app`, `session`, ...); two entries cannot
  compute the same name.
- **Temporary**: every `exposes.tools` id must also be in `ui.tools`, because
  the tool-call route only accepts that allowlist today.

### `--access`

`--access read` is the default: write and approve tools are not registered and
a stderr line reports how many were hidden. Opt in with
`--access read,write` (or `read,write,approve`).

### Apps without `exposes.tools`

The previous behaviour is kept: every `ui.tools` name is registered verbatim
with a generic `{ args }` payload, and a warning goes to stderr. Declare
`exposes.tools` to scope it.

The app must already be installed (`agentproto app install <dir>`) and declare
`exposes.tools` or a `ui.tools` allowlist in `APP.md`; `mcp-app` refuses to
serve an app with neither rather than falling back to exposing every daemon
tool.

## Daemon dependency

Starting the process needs no running daemon — it only reads the app's
`APP.md` off disk to build the tool list. Only an actual tool **call** needs
`agentproto serve` up; when it isn't, a call returns a clear MCP error result
("could not reach the daemon ... Start it: `agentproto serve`") rather than
the process crashing or refusing to start.

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `AGENTPROTO_DAEMON_URL` | `http://127.0.0.1:<daemon.port>` | Daemon base URL override (same env var `_daemon-helpers.ts` reads elsewhere in the CLI). |

The default port is read from `~/.agentproto/config.json` → `daemon.port`
(default `18790`).

## Registering in a stdio MCP client

```json
{
  "mcpServers": {
    "my-book": {
      "command": "agentproto",
      "args": ["mcp-app", "my-book"]
    }
  }
}
```

[`install-mcp --app <appId>`](./install-mcp.md#--app-appid-scoped-registration-for-a-booklibrary-app)
writes this entry for you (cursor, codex, claude-desktop, windsurf) instead
of hand-editing a client's config.

## Startup

```text
agentproto mcp-app: serving 6 tool(s) for app "my-book" (dispatching to http://127.0.0.1:18790/apps/my-book/tool-call)
```

The process parks forever — `StdioServerTransport` stays alive until stdin
closes or the process is killed.

## Errors

```text
agentproto mcp-app: no installed app "my-book" — run `agentproto app install <dir>` first.
agentproto mcp-app: app "my-book" has no `ui.tools` allowlist declared in APP.md — mcp-app requires an explicit allowlist to scope what a buyer's MCP client can see. Add `exposes: { prefix, tools: [...] }` (or `ui: { tools: [...] }`) to APP.md.
agentproto mcp-app: invalid `exposes.tools`: <APP.md path>: <reason>
agentproto mcp-app: --access takes read, write, approve (comma-separated), got "admin"
```

## See also

- [`install-mcp.md`](./install-mcp.md) — writes this command into a client's config for you (`--app`)
- [`mcp-bridge.md`](./mcp-bridge.md) — the unscoped, full-daemon equivalent
- [`app.md`](./app.md) — `app install`, the prerequisite for `mcp-app`
- [`serve.md`](./serve.md) — the daemon that answers `/apps/:appId/tool-call`

## Standalone HTTP mode (`--http`)

`agentproto mcp-app --http <appDir>` serves ONE app directory as a streamable-HTTP
MCP App with no daemon behind it: only the app's own bundled
`.agentproto/tools/<id>/TOOL.md` tools (run through its bundled drivers) plus its
`ui://` resource, restricted to the declared `ui.tools` allowlist.

- Single tenant: `POST /mcp`; secrets come from env vars named in the app's
  `requirements.secrets` (a missing one logs a warning).
- Multi tenant (`--tenants file.json`, `{ "<slug>": { "<SECRET>": "<value>" } }`):
  `POST /mcp/<slug>`. Secret names must be declared by the app; slugs are
  lowercase letters, digits and `-`.
- `--port` must be an integer in 1..65535; every flag needs a value.
- By default every served tool is linked to the app's `ui://` resource. An app
  can narrow that with an optional `ui.renders` list in `APP.md` (a subset of
  `ui.tools`); only those tools open the UI panel.

**No built-in authentication.** Anyone who can reach the port can call the served
tools with the (tenant's) secrets. The tenant slug in the URL only selects which
secrets apply; it is NOT a credential. For anything beyond loopback, run it
behind a front proxy that terminates TLS and authenticates the caller (and maps
the caller to a tenant slug). Built in: `Host`/`Origin` are checked against the
loopback names when bound to loopback (DNS-rebinding guard; `allowedHosts` in the
programmatic API for other binds), request bodies are capped at 1 MiB, and only
`POST` is served.
