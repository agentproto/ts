# `agentproto adapters`

```text
agentproto adapters list                       Show enabled adapters
agentproto adapters show <pkg>                 Print an adapter's manifest
agentproto adapters install <pkg>              npm i -g + add to config
agentproto adapters uninstall <pkg>            Remove from config (+ npm rm)
agentproto adapters enable <pkg>               Add to config (assume installed)
agentproto adapters disable <pkg>              Remove from config (keep installed)
agentproto adapters hermes-plugin status|install [--enable] [--json]
                                               Hermes system-prompt plugin
```

Manages runtime adapters. An adapter extends the swarm kernel's
registry with new `kind` strings — substrates, dispatchers,
participant executors, state stores. The enabled list lives in
`~/.agentproto/config.json` under `adapters[]`.

For adapter authoring (manifest shape, factory signatures, publishing),
see [`../../../PLUGINS.md`](../../../PLUGINS.md). This page is the
user-facing CLI surface only.

> **Naming note:** this verb was renamed from `plugins` to `adapters`
> to free "plugin" for the cross-vendor Agent Plugins v1.0.0 standard
> (see `@agentproto/plugin`). That leaves two distinct things both
> called "adapter" in this CLI: a CLI-driver adapter
> (`@agentproto/adapter-claude-code`, selected via `agentproto sessions
> start <adapter>` / installed via `install`) drives a specific coding
> agent, while what this page manages is a swarm-kernel adapter
> (formerly "plugin", e.g. `@guilde/agentproto-bridge`) that extends
> `run-swarm` with transport-specific substrates/dispatchers/executors.
> They're unrelated packages and registries; only the word collides.

## Adapter load order

`run-swarm` loads adapters in this order:

1. Built-ins via `registerBuiltins()` — `file` substrate, `mention`
   dispatcher, `fs` state store, `agent-cli` executor.
2. Adapters listed in `config.json#adapters`, in array order.
3. Adapters passed as `--adapter <module-id>` on the verb, in flag
   order.

**Last write wins.** Registering the same `kind` twice overrides the
prior factory. This is intentional — drop an adapter at the end of the
list to override a built-in or another adapter's registration.

## Subverbs

### `list`

```bash
agentproto adapters list
agentproto adapters list --json
```

Walks the `adapters[]` array, reads each adapter's manifest, prints
what it provides:

```text
• @guilde/agentproto-bridge
    substrates: guilde-mcp
    executors: db-operator
• @acme/agentproto-slack
    substrates: slack-thread
```

When an adapter has no manifest (legacy side-effect-import style), the
listing shows `(no manifest — legacy side-effect adapter)` and the
kinds it registers won't appear here — they'll still show up at
load time via `run-swarm --verbose`'s `registered: …` line.

`--json` emits the full manifests for scripting.

### `outdated`

```bash
agentproto adapters outdated
agentproto adapters outdated --json
```

Read-only freshness report for the installed agent-CLI adapter packages
(`claude-code`, `opencode`, …): the version actually in the global npm
tree vs the latest version published to the registry. Nothing is
installed, updated, or written — this only reports.

```text
• claude-code  @agentclientprotocol/claude-agent-acp 0.75.1 → 0.76.0  → update available
• opencode     opencode-ai 1.18.18 → 1.18.18  ✓ up to date
```

Both probes are time-bounded; offline or on a slow/404 registry a row
degrades to `freshness unknown` instead of guessing, and the verb still
exits 0. Packages not installed globally report `(not global — version
unknown)`.

`--json` emits `{ slug, package, installed, latest, status }` rows where
`status` is `current` | `behind` | `unknown`.

### `show`

```bash
agentproto adapters show @guilde/agentproto-bridge
agentproto adapters show @guilde/agentproto-bridge --json
```

Prints the full manifest for one adapter:

```text
@guilde/agentproto-bridge
  schema: agentproto/adapter/v1
  substrates:
    • kind: guilde-mcp
      entry: ./dist/index.mjs → guildeMcpSubstrateFactory
      capabilities: mentions, reactions, identity
      Reads/writes turns through Guilde's MCP server.
  executors:
    • kind: db-operator
      entry: ./dist/index.mjs → dbOperatorExecutorFactory
      Delegates to Mastra operators via run_operator.
```

`--json` dumps the raw manifest.

### `install` / `uninstall`

```bash
agentproto adapters install @guilde/agentproto-bridge
agentproto adapters install @your-org/agentproto-thing --local         # npm i (no -g)
agentproto adapters install @your-org/agentproto-thing --skip-npm      # add to config only

agentproto adapters uninstall @guilde/agentproto-bridge
agentproto adapters uninstall @guilde/agentproto-bridge --skip-npm     # config only
```

`install` runs `npm install [-g] <pkg>` then appends `<pkg>` to
`config.json#adapters`. `uninstall` removes it from the array then
runs `npm uninstall [-g] <pkg>`. Either side can be skipped:

| Flag | Effect |
|------|--------|
| `--local` | Use `npm install` (not `-g`). Useful for project-local adapters. |
| `--skip-npm` | Don't touch npm — just edit the config. Use after installing the package yourself or in CI. |

If `npm install` fails, the config is **not** modified. If `npm
uninstall` fails after the config edit, the warning is printed but
the adapter is already disabled.

### `enable` / `disable`

```bash
agentproto adapters enable @your-org/agentproto-thing
agentproto adapters disable @your-org/agentproto-thing
```

Config-only operations — assume the package is already installed (or
deliberately keep it installed). Adds/removes from `adapters[]`
without running npm. Equivalent to `install --skip-npm` /
`uninstall --skip-npm`.

### `hermes-plugin`

```bash
agentproto adapters hermes-plugin status
agentproto adapters hermes-plugin status --json
agentproto adapters hermes-plugin install
agentproto adapters hermes-plugin install --enable
```

Manages the bundled `agentproto-system-prompt` plugin for the hermes
harness. Hermes' ACP server has no system-prompt channel of its own, so
this plugin is what lets a projected AGENT.md reach hermes as a real
system prompt (up to 7500 chars); without it the text falls back to a
first-prompt prefix plus a `session:harness-warning`.

- `status` — where the plugin lives, whether it is installed and
  enabled, and the bundled version. Always exits 0.
- `install` — copies the bundled plugin into `$HERMES_HOME/plugins`
  (updating an older installed copy). Nothing else changes: the plugin
  is not active until enabled.
- `install --enable` — also runs `hermes plugins enable
  agentproto-system-prompt` (argv, never a shell, `config.yaml` is not
  edited by hand). Enabling is the explicit-consent step.

The daemon checks installed + enabled on every spawn, so installing takes
effect without a daemon restart. See
[`adapters/hermes/HERMES.md`](../../../adapters/hermes/HERMES.md) for the
channel details.

## Overriding a built-in

If an adapter registers `kind: "file"`, its factory replaces the
built-in `file` substrate from `registerBuiltins()`. Place it in the
`adapters[]` array (or pass `--adapter`) and you get the override on
the next `run-swarm`. Use `run-swarm --verbose` to confirm:

```text
agentproto run-swarm: registered: substrates=[file,guilde-mcp] dispatchers=[mention,…] executors=[agent-cli,db-operator] stateStores=[fs]
```

## Where it lives

```jsonc
// ~/.agentproto/config.json
{
  "adapters": [
    "@guilde/agentproto-bridge",
    "@acme/agentproto-slack"
  ]
}
```

You can hand-edit this file too — `agentproto adapters …` is just a
managed wrapper. See [`config.md`](./config.md) and
[`../concepts/plugins.md`](../concepts/plugins.md).
