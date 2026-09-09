# `agentproto sandbox`

```text
agentproto sandbox list   [--json]
agentproto sandbox attach <provider> <sandboxId> [--config-json <json>] [--keep-alive] [--json]
agentproto sandbox rm     <sandboxId|label|id-prefix> [--box] [--yes] [--json]
```

Browse the daemon's **sandbox ledger** (every box the daemon has booted,
reconnected to, or paused — stored in `~/.agentproto/sandboxes.json`), and
connect to already-existing boxes without tearing them down.

Provider credentials are read from `~/.agentproto/sandbox-creds/<slug>.json`
(written by the `setup_sandbox_provider` MCP tool); provider API keys (e.g.
`BOX_API_KEY`, `E2B_API_KEY`) must additionally be set in this process's own
environment.

## Subverbs

### `list`

```bash
agentproto sandbox list
agentproto sandbox list --json
```

Prints the sandbox ledger — every box the daemon has booted, reconnected
to, paused, or stopped — with its current state, idle-expiry, and the
origin session that spawned it.

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | `false` | Print the raw `{ sandboxes: […] }` JSON instead of the human table. |

### `rm <sandboxId|label|id-prefix>`

```bash
agentproto sandbox rm my-task-label
agentproto sandbox rm bx_abc123 --box --yes
```

Removes the ledger entry for the given box (resolved by exact label, full
`sandboxId`, or unique id prefix). By default the box itself is left
running/paused on the provider — only the local bookkeeping row is dropped.

| Flag | Default | Description |
|------|---------|-------------|
| `--box` | `false` | ALSO stop the box on its provider (destructive — the sandbox and all data inside it is torn down). Without `--yes`, an interactive terminal is asked to confirm. |
| `--yes` | `false` | Skip the interactive confirmation for `--box`. Required in non-TTY environments. |
| `--json` | `false` | Print `{ ok, removed, boxStopped }` as JSON. |

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
# Browse all boxes the daemon has touched
agentproto sandbox list
agentproto sandbox list --json

# Remove a ledger entry (box stays running/paused on the provider)
agentproto sandbox rm my-task-label
agentproto sandbox rm bx_abc123

# Remove ledger entry AND stop the box (destructive)
agentproto sandbox rm bx_abc123 --box --yes

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
      "headers": { "Cookie": "_port_auth=••••••••" }
    }
  }
}
```

The exact auth header is provider-specific and comes straight from the
descriptor's `authHeaders`. Box gates its private hostname on a
`Cookie: _port_auth=<token>` (its port edge ignores `Authorization: Bearer`);
a token-only provider falls back to `Authorization: Bearer <token>`.

## See also

- [`sessions.md`](./sessions.md) — `agent_start.sandbox` / `sessions start --sandbox` boots and drives a
  fresh sandbox; `sandbox list`/`attach`/`rm` operate on already-existing boxes
- [`auth.md`](./auth.md) — credential storage conventions
