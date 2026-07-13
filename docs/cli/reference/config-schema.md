# Config schema — `~/.agentproto/config.json`

The CLI's global config file. Location: `$AGENTPROTO_HOME/config.json`
(defaults to `~/.agentproto/config.json`). Created lazily — absent
until first `agentproto config set` or `agentproto plugins install`.

Read/write via [`agentproto config`](../verbs/config.md):

```bash
agentproto config show
agentproto config get plugins
agentproto config set daemon.port 18791
```

## Full shape

```jsonc
{
  // Runtime plugins loaded by `agentproto run-swarm`. Each entry is an
  // npm package id resolvable from the cli's install location OR the
  // user's cwd. Loaded in array order; last write wins on duplicate
  // adapter kinds.
  "plugins": [
    "@guilde/agentproto-bridge",
    "@acme/agentproto-slack"
  ],

  // Slug → package-name aliases for `agentproto install
  // runtime-profile/<slug>`. Without an alias, the verb defaults to
  // `@agentproto/runtime-profile-<slug>`.
  "profileAliases": {
    "guilde": "@guilde/runtime-profile-guilde"
  },

  // npm packages the `corpus` CLI scans for AIP-10 starter presets.
  // Each must declare `package.json#agentproto-corpus-preset` matching
  // the agentproto/corpus-preset/v1 schema. Defaults to just
  // ["@agentproto/corpus-presets"] when omitted.
  "corpusPresetPackages": [
    "@agentproto/corpus-presets",
    "@vendor/corpus-presets"
  ],

  // Daemon-mode options. Read by `agentproto daemon` and
  // `agentproto serve` when launched without explicit flags.
  "daemon": {
    "port": 18791,
    "bind": "127.0.0.1",
    "allowedOrigins": [
      "https://guilde.work"
    ]
  },

  // Global and per-adapter defaults auto-applied to every `agent_start`
  // spawn (CLI, MCP, or HTTP). See "defaults" below.
  "defaults": {
    "skills": ["review-checklist"],
    "options": { "verbose": true },
    "adapters": {
      "hermes": { "skills": ["hermes-only-skill"], "options": { "model": "z-ai/glm-5.2" } }
    },
    "defaultRoleDepthCutoff": 1,
    "maxGrantableDelegation": 2,
    "langfuseTracing": false,
    "traceRedactor": "secrets"
  },

  // Generic ACP agents — any CLI that speaks the Agent Client Protocol,
  // connectable with zero adapter code. Keyed by adapter slug; shadows a
  // curated ACP_CATALOG entry of the same slug. Managed via
  // `agentproto acp add|ls|rm`. See "acpAgents" below.
  "acpAgents": {
    "my-agent": {
      "bin": "my-agent",
      "bin_args": ["acp"],
      "resumable": true,
      "install_hint": "npm i -g my-agent"
    }
  }
}
```

## Keys

### `plugins: string[]`

npm packages with an `agentproto/plugin/v1` manifest. The CLI walks
this list at every `run-swarm` invocation, reads each plugin's
manifest, dynamic-imports declared adapter factories, and registers
them.

Managed via [`agentproto plugins`](../verbs/plugins.md). Direct edit
is fine — the verbs are convenience.

### `profileAliases: Record<string, string>`

Maps a runtime-profile slug to an npm package name. Lets you install
third-party profiles without typing the full package name:

```bash
# Without alias:
agentproto install runtime-profile/guilde \
  --package @guilde/runtime-profile-guilde

# With alias above:
agentproto install runtime-profile/guilde
```

The default resolver (`@agentproto/runtime-profile-<slug>`) still
applies when no alias matches.

### `corpusPresetPackages: string[]`

Only consumed by the `corpus` binary (`@agentproto/corpus-cli`). Each
listed package must declare `package.json#agentproto-corpus-preset`
listing its starter presets. `corpus init <slug>` resolves against the
merged set. `corpus init --list` enumerates everything visible.

### `daemon: object`

Defaults for `agentproto daemon` and `agentproto serve`:

| Field            | Type     | Meaning                                                |
| ---------------- | -------- | ------------------------------------------------------ |
| `port`           | number   | Listen port (default `18791`).                         |
| `bind`           | string   | Bind address (default `127.0.0.1` — loopback-only).    |
| `allowedOrigins` | string[] | CORS allow-list for browser callers of the daemon API. |

Verb flags override config; config overrides hard-coded defaults.

### `defaults: object`

Global and per-adapter defaults auto-applied to every `agent_start` spawn
(CLI `sessions start`/`run`, MCP `start_agent_session`, or the HTTP API) —
introduced in 0.5.0.

| Field                     | Type                                      | Meaning                                                              |
| ------------------------- | ------------------------------------------ | --------------------------------------------------------------------- |
| `skills`                  | `string[]`                                  | Global skills folded into every spawn's `options.skills`.             |
| `options`                 | `Record<string, boolean\|number\|string>`   | Global options merged into every spawn.                                |
| `adapters`                | `Record<string, { skills?, options? }>`     | Per-adapter overrides, keyed by adapter slug (e.g. `"hermes"`).        |
| `defaultRoleDepthCutoff`  | `number`                                    | Spawn depth at/above which a session defaults to `executor` instead of `supervisor` (default `1`). |
| `maxGrantableDelegation`  | `number`                                    | Trust-boundary cap on how much delegation a supervisor can grant a child. |
| `langfuseTracing`         | `boolean`                                   | Opt in to per-session Langfuse tracing by default.                     |
| `traceRedactor`           | `string`                                    | Redactor slug (e.g. `"secrets"`) applied to traced session content.    |

Merge precedence (low → high): `defaults.options` < `defaults.adapters.<slug>.options`
< the explicit `options` passed at spawn time. For `skills`, an explicit
`skills` array at spawn time *replaces* the union of `defaults.skills` and
`defaults.adapters.<slug>.skills` rather than merging with it. Adapters with
no declared `skills` option treat the resolved skills list as a no-op.

### `acpAgents: Record<string, object>`

Generic ACP agents — any CLI that already speaks the Agent Client Protocol,
connectable with zero adapter code. Keyed by adapter slug; each value is a
spawn recipe. A config entry **shadows** a curated `ACP_CATALOG` entry of the
same slug, and both lose to a real `@agentproto/adapter-<slug>` npm package
(resolution order: npm → config → catalog). Managed via
[`agentproto acp`](../verbs/acp.md); direct edit is fine.

| Field          | Type                                  | Meaning                                                        |
| -------------- | ------------------------------------- | -------------------------------------------------------------- |
| `bin`          | `string` (**required**)               | Executable to spawn (e.g. `"gemini"`).                         |
| `bin_args`     | `string[]`                            | Extra argv, e.g. `["--experimental-acp"]`.                     |
| `name`         | `string`                              | Display name. Default: the slug.                               |
| `description`  | `string`                              | One-line summary shown in `acp ls`.                            |
| `env`          | `Record<string, string>`              | Always-on environment variables for the spawn.                 |
| `resumable`    | `boolean`                             | Advertise `resumable` + native-resume continuation.           |
| `models`       | `{ default?, allowed? }`              | Known model ids (informational hint).                          |
| `install_hint` | `string`                              | Shown by `acp ls` when the bin is missing from `PATH`.        |

A malformed entry (no string `bin`) is dropped on load with a warning rather
than failing the whole config. See
[`concepts/adapters.md`](../concepts/adapters.md#generic-acp-agents-zero-code).

## Permissions

Mode `0600` is NOT enforced for `config.json` — unlike `credentials.json`,
this file doesn't carry secrets. Plugin names, ports, and alias maps
are not sensitive.

## Versioning

The config file is unversioned today. New keys may appear in any
minor release of the CLI; unknown keys are tolerated and preserved
across reads/writes. Removed keys are still readable but are no-ops.
See [`../../VERSIONING.md`](../../VERSIONING.md) for the broader
policy.
