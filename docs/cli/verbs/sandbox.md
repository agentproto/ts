# `agentproto sandbox`

```text
agentproto sandbox attach <provider> <sandboxId> [--config-json <json>] [--keep-alive] [--json]
```

Connect to an ALREADY-EXISTING sandbox (Box, e2b, …) without tearing it
down. A pure local shell over `@agentproto/runtime`'s `attachSandbox` — no
daemon required on this machine, since attach's whole point is reaching a
REMOTE sandbox's own daemon, not this one's. Provider credentials are read
the same way `agent_start.sandbox` reads them (`~/.agentproto/sandbox-creds/
<slug>.json`, written by the `setup_sandbox_provider` MCP tool), and provider
API keys (e.g. `BOX_API_KEY`, `E2B_API_KEY`) must additionally be set in
this process's own environment.

This is distinct from boot-and-drive (`agent_start.sandbox`, which boots a
fresh box and spawns an adapter ON it): attach resumes a box that already
exists, never calls `stop()`/`pause()` on it, and hands back a durable,
token-gated connection descriptor any MCP client — local Claude, a GitHub
Action, another ephemeral sandbox — can use to reach it directly.

## Subverbs

### `attach <provider> <sandboxId>`

Resumes the sandbox, ensures its agentproto daemon is healthy, and exposes
it with a PERSISTENT, token-gated URL (never an ungated one — a provider
that can't gate the port fails the command rather than printing an
insecure URL). Prints the connection descriptor and a paste-ready
`.mcp.json` snippet.

| Flag | Default | Description |
|------|---------|-------------|
| `--config-json <json>` | `{}` | Provider-specific `SandboxSpec.config` overrides, e.g. `'{"port":18790}'`. |
| `--keep-alive` | `false` | Keep the sandbox awake indefinitely for an always-on rendezvous. |
| `--json` | `false` | Print only `{"descriptor":…,"mcpConfig":…}` as JSON. |

### The always-on model (`--keep-alive`)

`--keep-alive` is for a sandbox meant to stay reachable indefinitely rather
than get reclaimed by the provider's own idle/TTL auto-stop. The documented
Box mechanism for "runs until you stop it" is **no-auto-stop**
(`box extend <id> --no-auto-stop` / `ttlSeconds: null`), and it's **sticky
across resume** — so `--keep-alive` (re-)asserts it on `connect()`,
defensively, even for a box that already defaults to it (e.g. one created
before that default, or with an explicit numeric `ttlSeconds`). It does
**not** start a background heartbeat process — a one-shot CLI invocation
can't cleanly host one, and no-auto-stop has no deadline to begin with, so
none is needed. `--keep-alive` is a no-op for providers with no equivalent
concept (e.g. e2b).

## Examples

```bash
# Attach to a Box sandbox booted by an earlier agent_start sandbox spawn
agentproto sandbox attach box bx_abc123

# Pin it awake indefinitely for an always-on rendezvous
agentproto sandbox attach box bx_abc123 --keep-alive

# Same, machine-readable
agentproto sandbox attach e2b sbx_abc123 --json

# Override the port the daemon listens on inside the box
agentproto sandbox attach box bx_abc123 --config-json '{"port":19000}'
```

Non-JSON output:

```text
sandbox attached  provider=box  sandboxId=bx_abc123
  mcpUrl      https://frazil-pneuma-rallye-18790.on.ascii.dev/mcp
  token       •••••••• (gated)
  allowOrigin https://frazil-pneuma-rallye-18790.on.ascii.dev
  keepAlive   no

Paste into .mcp.json:
{
  "mcpServers": {
    "sandbox-box-bx_abc123": {
      "type": "http",
      "url": "https://frazil-pneuma-rallye-18790.on.ascii.dev/mcp",
      "headers": { "Authorization": "Bearer ••••••••" }
    }
  }
}
```

## See also

- [`sessions.md`](./sessions.md) — `agent_start.sandbox` boots and drives a
  fresh sandbox; this verb only attaches to one that already exists
- [`auth.md`](./auth.md) — credential storage conventions
