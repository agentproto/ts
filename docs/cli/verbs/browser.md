# `agentproto browser`

```text
agentproto browser install <adapter> [--force] [--dry-run] [--only <step>...]
agentproto browser start   <adapter> [--port N] [--camofox-port N] [--label L]
                                     [--non-interactive] [--json]
agentproto browser stop    <session-id>            [--json]
agentproto browser list    [--alive]               [--json]
agentproto browser status  <session-id>            [--json]
```

Manage browser service sessions (Camofox, Bureau, Chromium, chrome-live) registered on
the local daemon. The CLI is an HTTP wrapper over the daemon's
`/sessions/browser` routes for shell scripting and inspection. The daemon's
MCP browser tools no longer use these sessions: they forward to Bureau (see
the runtime README), and `start_browser` / `stop_browser` / `browser_status`
are gone. This verb is removed in P4b.

Requires a running daemon ([`serve.md`](./serve.md) or
[`daemon.md`](./daemon.md)). Discovery reads `~/.agentproto/runtime.json`.

## Adapters

| Adapter   | Description                              | Default port |
|-----------|------------------------------------------|:-----------:|
| `camofox` | Stealth Firefox headless                 | 9377        |
| `bureau`  | Camofox + MCP capability server          | 8830        |
| `chromium`| Chromium browser service                 | 3200        |
| `chrome-live` | A dedicated headful Chrome by default (no consent click); `attachIntent: true` attaches to your own running Chrome through `chrome://inspect/#remote-debugging` instead | 9222 |

`chrome-live` launches (or reuses, hot) a **dedicated headful Chrome** by
default — no attach attempt, no consent wait, your own Chrome is never dialed.
Pass `attachIntent: true` in the launch options (or pin a `wsUrl`/`port`) to
ask for your own running Chrome instead: turn on the remote debugging toggle
and click **Allow** when the session starts. If that attach is not possible
(toggle off, or the Allow click never comes), it falls back to the dedicated
Chrome so the agent is never stuck. The agent works in its own window and only
touches tabs it opened; `stop` closes those tabs and its own connection, and
kills only the Chrome it launched itself, never your Chrome. Cookies are
read-only. See the
[adapter README](../../../adapters/browser-chrome/README.md#chrome-live-your-running-chrome).

The MCP tools `browser_screencast_start` / `browser_screencast_frame` /
`browser_screencast_stop` forward to Bureau's `browser_record_start` /
`browser_record_frame` / `browser_record_stop`. Pass the owned `tabId` (Bureau
requires it) and optionally `instance`; `start` also forwards `fps` and
`format`, `stop` forwards `encode`. `quality`, `everyNthFrame`, `maxWidth` and
`maxHeight` have no Bureau equivalent and are dropped, listed in the result's
`notes`. The result is Bureau's own, and Bureau's error codes
(`browser:not_owner`, `browser:recording_active`,
`browser:recording_not_found`, `browser:recording_cancelled`) come back
unchanged. The daemon's `/sessions/<sessionId>/screencast` HTTP viewer only
serves a chrome-live session started through this CLI.

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