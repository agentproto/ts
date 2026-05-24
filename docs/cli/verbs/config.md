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
| `plugins` | `string[]` | Plugin package ids loaded by `run-swarm`. Managed via [`plugins.md`](./plugins.md). |
| `profileAliases` | `Record<string,string>` | Map of `runtime-profile/<name>` → npm package, for third-party profiles. See [`../concepts/runtime-profiles.md`](../concepts/runtime-profiles.md). |
| `daemon.port` | `number` | Default `18790`. |
| `daemon.bind` | `string` | Default `127.0.0.1`. |
| `daemon.workspace` | `string` | Absolute path; passed as `serve --workspace` when set. |
| `daemon.allowedOrigins` | `string[]` | Trusted browser origins for mutating routes (in addition to localhost defaults). |
| `daemon.strictOrigins` | `boolean` | When true, drop the localhost-default. Only `allowedOrigins` are honoured. |
| `daemon.label` | `string` | Server label sent in tunnel hello frames. |
| `tunnel.host` | `string` | Default tunnel URL for `serve` and `daemon install`. |
| `tunnel.autoconnect` | `boolean` | When true, `daemon install` bakes `--connect tunnel.host` into the plist; `serve` falls back to it when `--connect` is omitted. |
| `features.pty` | `boolean` | Informational hint; the daemon detects `node-pty` at runtime regardless. |
