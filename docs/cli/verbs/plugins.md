# `agentproto plugins`

```text
agentproto plugins list                       Show enabled plugins + adapters
agentproto plugins show <pkg>                 Print a plugin's manifest
agentproto plugins install <pkg>              npm i -g + add to config
agentproto plugins uninstall <pkg>            Remove from config (+ npm rm)
agentproto plugins enable <pkg>               Add to config (assume installed)
agentproto plugins disable <pkg>              Remove from config (keep installed)
```

Manages runtime plugins. A plugin extends the swarm kernel's adapter
registry with new `kind` strings — substrates, dispatchers,
participant executors, state stores. The enabled list lives in
`~/.agentproto/config.json` under `plugins[]`.

For plugin authoring (manifest shape, factory signatures, publishing),
see [`../../../PLUGINS.md`](../../../PLUGINS.md). This page is the
user-facing CLI surface only.

> **Adapters vs plugins:** an *adapter* (`@agentproto/adapter-claude-code`)
> defines how to drive a specific CLI agent. A *plugin*
> (`@guilde/agentproto-bridge`) extends the swarm kernel with
> transport-specific code (substrates, dispatchers, …). They're
> different concepts; the verbs that touch them are `install` for
> adapters and `plugins install` for plugins.

## Plugin load order

`run-swarm` loads plugins in this order:

1. Built-ins via `registerBuiltins()` — `file` substrate, `mention`
   dispatcher, `fs` state store, `agent-cli` executor.
2. Plugins listed in `config.json#plugins`, in array order.
3. Plugins passed as `--plugin <module-id>` on the verb, in flag
   order.

**Last write wins.** Registering the same `kind` twice overrides the
prior factory. This is intentional — drop a plugin at the end of the
list to override a built-in or another plugin's adapter.

## Subverbs

### `list`

```bash
agentproto plugins list
agentproto plugins list --json
```

Walks the `plugins[]` array, reads each plugin's manifest, prints
what it provides:

```text
• @guilde/agentproto-bridge
    substrates: guilde-mcp
    executors: db-operator
• @acme/agentproto-slack
    substrates: slack-thread
```

When a plugin has no manifest (legacy side-effect-import style), the
listing shows `(no manifest — legacy side-effect plugin)` and the
kinds it registers won't appear here — they'll still show up at
load time via `run-swarm --verbose`'s `registered: …` line.

`--json` emits the full manifests for scripting.

### `show`

```bash
agentproto plugins show @guilde/agentproto-bridge
agentproto plugins show @guilde/agentproto-bridge --json
```

Prints the full manifest for one plugin:

```text
@guilde/agentproto-bridge
  schema: agentproto/plugin/v1
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
agentproto plugins install @guilde/agentproto-bridge
agentproto plugins install @your-org/agentproto-thing --local         # npm i (no -g)
agentproto plugins install @your-org/agentproto-thing --skip-npm      # add to config only

agentproto plugins uninstall @guilde/agentproto-bridge
agentproto plugins uninstall @guilde/agentproto-bridge --skip-npm     # config only
```

`install` runs `npm install [-g] <pkg>` then appends `<pkg>` to
`config.json#plugins`. `uninstall` removes it from the array then
runs `npm uninstall [-g] <pkg>`. Either side can be skipped:

| Flag | Effect |
|------|--------|
| `--local` | Use `npm install` (not `-g`). Useful for project-local plugins. |
| `--skip-npm` | Don't touch npm — just edit the config. Use after installing the package yourself or in CI. |

If `npm install` fails, the config is **not** modified. If `npm
uninstall` fails after the config edit, the warning is printed but
the plugin is already disabled.

### `enable` / `disable`

```bash
agentproto plugins enable @your-org/agentproto-thing
agentproto plugins disable @your-org/agentproto-thing
```

Config-only operations — assume the package is already installed (or
deliberately keep it installed). Adds/removes from `plugins[]` without
running npm. Equivalent to `install --skip-npm` / `uninstall --skip-npm`.

## Overriding a built-in

If a plugin registers `kind: "file"`, its factory replaces the
built-in `file` substrate from `registerBuiltins()`. Place it in the
`plugins[]` array (or pass `--plugin`) and you get the override on
the next `run-swarm`. Use `run-swarm --verbose` to confirm:

```text
agentproto run-swarm: registered: substrates=[file,guilde-mcp] dispatchers=[mention,…] executors=[agent-cli,db-operator] stateStores=[fs]
```

## Where it lives

```jsonc
// ~/.agentproto/config.json
{
  "plugins": [
    "@guilde/agentproto-bridge",
    "@acme/agentproto-slack"
  ]
}
```

You can hand-edit this file too — `agentproto plugins …` is just a
managed wrapper. See [`config.md`](./config.md) and
[`../concepts/plugins.md`](../concepts/plugins.md).
