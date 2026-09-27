# `agentproto settings`

```text
agentproto settings export [--out <file>] [--json]
                            [--include-secrets <profile-id>...] [--passphrase-env <VAR>]
agentproto settings import <file> [--dry-run] [--yes] [--json]
                            [--unseal-passphrase-env <VAR>]
```

"Bring my main setup" — snapshot this machine's `agentproto` configuration
into one versioned JSON bundle, then apply it to another machine. Both sides
are pure local file I/O; nothing round-trips through a daemon or the network.

The bundle covers: installed adapters (slug + version), harness→profile
presets, auth-profile **metadata** (id, endpoint, method — never a
credential), named LLM endpoints (`~/.agentproto/llm-endpoints.json`),
imported-MCP pointers (`~/.agentproto/imported-mcps.json`), and a sanitized
slice of `~/.agentproto/config.json`. Cron jobs are never included — a
`kind: "command"` cron action can embed an arbitrary shell command, secrets
and all, and they live in the daemon's in-memory scheduler rather than a
plain file; use [`cron.md`](./cron.md) directly on the target machine.

## Secret discipline

Nothing sensitive rides in a bundle unless explicitly asked for:

- **Auth-profile credentials are never included by default.** Every profile
  exports as `{id, endpoint, method, label?, origin?}` — the store pointer
  (`credentialRef`) is dropped; it's local-only and meaningless on another
  machine anyway.
- `--include-secrets <profile-id>` (repeatable) seals that profile's stored
  credential into the bundle under a passphrase (`--passphrase-env <VAR>` —
  never pass the passphrase as a bare argument; it belongs in an env var, not
  your shell history). Sealing is scrypt → AES-256-GCM, keyed by the
  passphrase alone. Sealing to a paired device's public key instead of a
  passphrase is planned once the device registry exists, but isn't wired up
  yet.
- An imported MCP server's `env`/`headers` can carry literal secrets (an
  `Authorization` header, an API-key env var) — only the **key names** ride
  in the bundle, mirroring how `llm-endpoints.json`'s `apiKeyEnv` is already
  a name, not a value. A stdio MCP's `command`/`args` are dropped entirely
  (not just redacted) when either embeds an absolute local path, since that
  leaks the source machine's username and directory layout.
- `config.json` is walked recursively. A key the runtime's own schema marks
  `secret: true` is dropped (including a per-profile override like
  `profiles.<name>.tunnel.token`, which mirrors the top-level shape one level
  down), as is any string value shaped like a credential by its key name
  (`token`, `apiKey`, `password`, …) even where the schema doesn't yet cover
  it, and any string that looks like an absolute filesystem path or a
  loopback address (machine-specific, not secret, but still not portable).
  Every drop is reported by dotted path — never by value.

## `export`

```bash
agentproto settings export
agentproto settings export --out my-setup.json
agentproto settings export --include-secrets work-openrouter --passphrase-env SETTINGS_PASSPHRASE
```

```text
Wrote settings bundle → ./agentproto-settings-2026-09-27.json

  14 adapter(s)
  8 harness preset(s)
  21 auth profile(s) (metadata only)
  1 LLM endpoint(s)
  14 imported MCP server(s) (env/header VALUES stripped)
  10 config.json key(s) (14 skipped — secret or machine-specific)
```

| Flag | Default | Description |
|------|---------|-------------|
| `--out <file>` | `./agentproto-settings-<date>.json` | Where to write the bundle. |
| `--include-secrets <profile-id>` | (none) | Seal this auth profile's stored credential into the bundle. Repeatable. Requires `--passphrase-env`. |
| `--passphrase-env <VAR>` | — | Env var holding the seal passphrase. Only valid with `--include-secrets`. |
| `--json` | `false` | Emit `{path, bundle, warnings}` instead of the human summary. |

A profile id that can't be sealed (unknown id, a source-backed profile with
no stored secret, a keychain read failure) doesn't abort the export — it's
reported in `warnings` and simply left out of the bundle.

## `import`

```bash
agentproto settings import my-setup.json --dry-run
agentproto settings import my-setup.json --yes
agentproto settings import my-setup.json --yes --unseal-passphrase-env SETTINGS_PASSPHRASE
```

```text
Plan for this bundle (from other-machine.local, 2026-09-27T16:58:21.652Z):

  auth profiles: 3 to add, 18 skipped
  harness presets: 1 to add, 7 skipped
  LLM endpoints: 0 to add, 1 skipped
  imported MCP servers: 2 to add, 12 skipped
  config.json keys: 4 to add, 26 skipped

(dry run — nothing was applied)
```

Import is **additive only**: an entry that already exists locally (same id,
or an already-set `config.json` key) is left completely untouched and
reported as skipped, never overwritten. A bundled auth profile with no
matching sealed secret — or a bundle with sealed secrets but no
`--unseal-passphrase-env` — is created **disabled**: a shape-only
placeholder an operator fills in afterward with a real credential
(`agentproto auth login`, or the `auth_profile_create` MCP tool). A harness
preset that references a still-disabled profile fails its own validation and
is reported skipped with the reason, rather than aborting the rest of the
import.

| Flag | Default | Description |
|------|---------|-------------|
| `--dry-run` | `false` | Compute and print the plan; write nothing. |
| `--yes` | `false` | Apply without an interactive confirmation. Required when not running in a TTY. |
| `--unseal-passphrase-env <VAR>` | — | Env var holding the passphrase to restore any sealed secrets the bundle carries. Omitted ⇒ those profiles land disabled, with no credential. |
| `--json` | `false` | Emit the full apply report instead of the human summary. |

Adapters the bundle names that aren't installed locally are listed with an
`agentproto install <slug>` hint — never auto-installed, since an adapter
install shells out and can fetch/run arbitrary code. Cron jobs are never
part of a bundle, so import never creates one.

## See also

- [config.md](./config.md) — hand-editing `~/.agentproto/config.json`
  directly; `settings import` only ever adds a key that's unset there.
- [llm.md](./llm.md) — the named LLM endpoints a bundle carries.
- [install-mcp.md](./install-mcp.md) — the imported-MCP store a bundle's
  `mcpServers` merge into.
- [auth.md](./auth.md) — creating/enabling a real credential for a disabled
  profile stub after import.
