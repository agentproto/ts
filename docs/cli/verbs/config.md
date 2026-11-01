# `agentproto config`

```text
agentproto config show                 dump the full config as JSON
agentproto config path                 print the config file path
agentproto config get <key>            read one dot-notation key
agentproto config set <key> <value>    write a key (JSON-parsed when valid)
agentproto config unset <key>          delete a key
agentproto config edit                 open the file in $EDITOR
```

Hand-editable defaults at `~/.agentproto/config.json` (or
`$AGENTPROTO_HOME/config.json` when set). Resolution order for every
daemon knob:

1. CLI flag
2. Env var (where one exists)
3. `config.json`
4. Hardcoded default

CLI flags always win — `config.json` is for defaults, not lock-in.
Full key reference: [`../reference/config-schema.md`](../reference/config-schema.md).

## Subverbs

### `show`

```bash
agentproto config show
```

Dumps the entire config as pretty JSON. Unknown keys are preserved
across CLI versions, so this surface is forward-compatible.

### `path`

```bash
agentproto config path
# → /Users/<you>/.agentproto/config.json
```

Prints the config file path. Scripting helper.

### `get`

```bash
agentproto config get daemon.port
# → 18791
```

Dot-notation lookup. Exits non-zero when the key is unset.

### `set`

```bash
agentproto config set daemon.port 18791
agentproto config set daemon.allowedOrigins https://guilde.work,https://app.example.com
agentproto config set tunnel.host wss://guilde.work/api/v1/agentproto/tunnel
agentproto config set features.pty true
```

Value parsing rules (in order):

1. `true`, `false`, `null` → JSON literal.
2. Valid JSON (numbers, arrays, objects, quoted strings) → parsed.
3. Comma in value, not starting with `"` → split into a string array,
   trimmed.
4. Otherwise → stored as a string.

So `daemon.port 18791` is stored as number `18791`, and
`daemon.allowedOrigins https://a.com,https://b.com` is stored as
`["https://a.com", "https://b.com"]`. To force a literal JSON shape,
quote it at the shell: `agentproto config set foo '["a","b"]'`.

The file is written atomically (tmp + rename) so a concurrent
`agentproto config edit` can't half-truncate it.

### `unset`

```bash
agentproto config unset tunnel.host
```

Removes the key. Unsetting a missing key is a no-op (exit 0).

### `edit`

```bash
agentproto config edit
```

Opens the config in `$EDITOR` (falling back to `$VISUAL`, then `vi`).
Creates the file if missing before launching the editor.

## Common keys

| Key | Type | Notes |
|-----|------|-------|
| `adapters` | `string[]` | Swarm-kernel adapter package ids loaded by `run-swarm`. Managed via [`adapters.md`](./adapters.md). (Formerly `plugins[]` — the verb was renamed `plugins`→`adapters`.) |
| `profileAliases` | `Record<string,string>` | Map of `runtime-profile/<name>` → npm package, for third-party profiles. See [`../concepts/runtime-profiles.md`](../concepts/runtime-profiles.md). |
| `daemon.port` | `number` | Default `18790`. |
| `daemon.bind` | `string` | Default `127.0.0.1`. |
| `daemon.workspace` | `string` | Absolute path; passed as `serve --workspace` when set. |
| `daemon.allowedOrigins` | `string[]` | Trusted browser origins for mutating routes (in addition to localhost defaults). |
| `daemon.strictOrigins` | `boolean` | When true, drop the localhost-default. Only `allowedOrigins` are honoured. |
| `daemon.label` | `string` | Server label sent in tunnel hello frames. |
| `daemon.reviewSessionRetentionDays` | `number` | Days after which a terminal review-lane session dir (`~/.agentproto/sessions/<id>/`) is deleted by the retention sweep. Default `7`; `0` disables. See [`sessions gc --retention`](./sessions.md#gc). |
| `daemon.sessionRetentionDays` | `number` | Same, for every other terminal session. Default off (unset / `0`). Pinned, `keepAlive` and live sessions are never deleted. |
| `daemon.idleReapAfterMs` | `number` | Retire an idle agent-cli session after this many ms (SIGTERM the adapter, row `killed` / `idle-reaped`, lazily resumable). Default off (unset / `0`). Env: `AGENTPROTO_IDLE_REAP_AFTER_MS`. Needs a restart. |
| `daemon.bootResumeKeepAliveMaxIdleHours` | `number` | With `resumeSessionsOnBoot`, stop eagerly resuming a `keepAlive` session idle longer than this many hours (from its last turn-end). It stays lazy-resumable on the next prompt. Pinned and operator-labelled sessions always resume. Default `24`; `0` disables the cutoff. Needs a restart. |
| `daemon.sandboxIdleReapAfterMs` | `number` | Shorter idle threshold for **sandboxed** sessions (a session in a provider box: e2b, …). Default `900000` (15 min); `0` turns it off. Env: `AGENTPROTO_SANDBOX_IDLE_REAP_AFTER_MS`. Needs a restart. See [Sandbox idle reap](#sandbox-idle-reap). |
| `tunnel.host` | `string` | Default tunnel URL for `serve` and `daemon install`. |
| `tunnel.autoconnect` | `boolean` | When true, `daemon install` bakes `--connect tunnel.host` into the plist; `serve` falls back to it when `--connect` is omitted. |
| `tunnel.e2e` | `boolean` | Opt into end-to-end encrypting the outbound tunnel (needs `tunnel.token`; the host must also support it, else it falls back to plaintext). See [`serve`](./serve.md#end-to-end-encryption-tunnele2e-opt-in). |
| `features.pty` | `boolean` | Informational hint; the daemon detects `node-pty` at runtime regardless. |

## Sandbox idle reap

A finished turn does not close a session, so a sandboxed session sits idle with
its box (a billed VM) running until the provider lifetime expires.
`daemon.sandboxIdleReapAfterMs` bounds that: a session running in a provider
box that has been idle this long is reaped, and its box goes with it.

- **Applies to** sessions with a provider box (`sandboxId` set, not a
  `device:` spawn). Non-sandbox sessions are unaffected and keep following
  `daemon.idleReapAfterMs` only. If both knobs are on, a sandboxed session is
  reaped at the shorter one; if the sandbox knob is `0`, it falls back to the
  general knob.
- **A box's own idle window wins when shorter**: a spec that declares
  `lifecycle.pause_after_idle` (e.g. `idle-120`) is reaped, and so paused,
  after that window rather than the knob's, while the sandbox knob is on. On
  e2b, such a box is also created with `lifecycle.onTimeout: "pause"`, so a box
  that outlives its provider timeout is parked rather than destroyed
  (override with the provider's `config.onTimeout`).
- **Never reaped** while busy, awaiting input or a permission decision, blocked
  on a command or sub-agent, running a background task, parent of a live child
  session, archived, or `keepAlive`.
- **Teardown order**: final checkpoint of the box's work (uncommitted changes
  included, capped at 2 min so a hung checkpoint cannot keep the box alive),
  then the box session is killed, the work branch is delivered, and the box is
  killed. A spec that asked to pause (`lifecycle.pause_after_idle`, or a `reuse`
  boot) pauses it instead; `lifecycle.destroy_on` always kills.
- **Ledger**: the row for the box in `~/.agentproto/sandboxes.json` ends in
  `stopped` (or `paused`) and records `reapedAt`, `reapedIdleMs` and
  `reapedSessionId`.
- **Revival**: the session row stays (`killed` / `idle-reaped`). A later prompt
  cold-boots a fresh box from the checkpoint branch (the same path as
  `session_restart`) and delivers the prompt there. The old row is superseded
  (`continuedTo`); later prompts to the old id are told to use the new one.
  A failed move fails the prompt with the blocker rather than resuming an
  adapter on the host.

```sh
agentproto config set daemon.sandboxIdleReapAfterMs 600000   # 10 min
agentproto config set daemon.sandboxIdleReapAfterMs 0        # never reap boxes
```
