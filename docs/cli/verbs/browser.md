# `agentproto browser`

```text
agentproto browser install <adapter> [--force] [--dry-run] [--only <step>...]
agentproto browser start   <adapter> [--port N] [--camofox-port N] [--label L]
                                     [--non-interactive] [--json]
agentproto browser stop    <session-id>            [--json]
agentproto browser list    [--alive]               [--json]
agentproto browser status  <session-id>            [--json]
```

Manage browser service sessions (Camofox, Bureau, Chromium) registered on
the local daemon. The daemon hosts the MCP tools (`start_browser`,
`stop_browser`, …); the CLI is an HTTP wrapper over the same routes for
shell scripting and inspection.

Requires a running daemon ([`serve.md`](./serve.md) or
[`daemon.md`](./daemon.md)). Discovery reads `~/.agentproto/runtime.json`.

## Adapters

| Adapter   | Description                              | Default port |
|-----------|------------------------------------------|:-----------:|
| `camofox` | Stealth Firefox headless                 | 9377        |
| `bureau`  | Camofox + MCP capability server          | 8830        |
| `chromium`| Chromium browser service                 | 3200        |

## Subverbs

### `install <adapter>`

Runs the adapter's declared config prompts interactively and persists the
results to `~/.agentproto/browser-adapters/<id>.json`. Subsequent `start`
calls read this config automatically — no prompts needed unless new
required steps appear.

| Flag | Default | Description |
|------|---------|-------------|
| `--force`, `-f` | `false` | Re-run all prompts even if already answered. |
| `--dry-run` | `false` | Print what would happen without persisting. |
| `--only <step>` | — | Run only the named step(s). Repeatable. |

### `start <adapter>`

Starts a browser service session via `POST /sessions/browser`. If required
config steps are missing and the terminal is interactive, prompts run
before the request. Pass `--non-interactive` to fail fast instead.

| Flag | Default | Description |
|------|---------|-------------|
| `--port N` | adapter default | Override the browser's listen port. |
| `--camofox-port N` | adapter default | (Bureau only) Camofox backend port. |
| `--label L` | — | Human-readable label for the session. |
| `--non-interactive` | `false` | Fail if required config is missing instead of prompting. |
| `--json` | `false` | Emit the session descriptor as JSON. |

### `stop <session-id>`

Sends `SIGTERM` to the browser session via `POST /sessions/:id/kill`.
Idempotent — reports "not running" if already dead.

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | `false` | Emit `{"ok":bool,"sessionId":str}` as JSON. |

### `list`

Lists browser sessions known to the daemon.

| Flag | Default | Description |
|------|---------|-------------|
| `--alive` | `false` | Show only running sessions. |
| `--json` | `false` | Emit an array of session descriptors. |

### `status <session-id>`

Prints a detailed descriptor for one browser session, including a
best-effort `/health` probe (3-second timeout) against the browser's base URL.

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | `false` | Emit `{descriptor, healthy, healthBody}` as JSON. |

## Examples

```bash
# First-time setup for Camofox
agentproto browser install camofox

# Start a Bureau session (Camofox + MCP tools)
agentproto browser start bureau --label "debug-run"

# Start Bureau on custom ports
agentproto browser start bureau --port 8831 --camofox-port 9378

# List alive browser sessions
agentproto browser list --alive

# Inspect one session
agentproto browser status sess_abc12345

# Stop a session
agentproto browser stop sess_abc12345

# Reinstall config from scratch
agentproto browser install camofox --force
```

## See also

- [`serve.md`](./serve.md) — daemon that hosts browser sessions
- [`daemon.md`](./daemon.md) — managed background service
- [`sessions.md`](./sessions.md) — generic session listing and control