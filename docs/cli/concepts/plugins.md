# Plugins

A **plugin** extends `agentproto run-swarm`'s runtime registry with
new substrates, dispatchers, participant executors, or state stores —
the four port kinds the MultiAgentRuntime kernel composes per swarm.

Plugins ship as npm packages, declare what they provide via the
`agentproto/plugin/v1` manifest, and are managed with the
[`agentproto plugins`](../verbs/plugins.md) verb.

## Quick example

```bash
agentproto plugins install @guilde/agentproto-bridge
agentproto plugins list
agentproto plugins show @guilde/agentproto-bridge
```

After install, the bridge's `guilde-mcp` substrate and `db-operator`
executor are wired automatically — manifests can reference those
kinds:

```yaml
substrate:
  kind: guilde-mcp
  endpoint: https://guilde.work/mcp
  conversationId: <uuid>
participants:
  - id: curator
    executor: db-operator
    meta:
      operatorId: <uuid>
```

## Authoring

The canonical doc for plugin authoring is
[`PLUGINS.md`](../../../PLUGINS.md) at the ts/ repo root — it covers
the manifest shape, factory signatures, the install/manage flow, and
the scope conventions for publishing.

In one paragraph: declare what your package provides under
`package.json#agentproto` (or a standalone `agentproto.json`), export
the factory functions named in the manifest's `entry`/`export`
fields, and the CLI takes care of the wiring at swarm startup. No
side-effect registrations needed — the manifest IS the declaration.

## Plugin vs adapter

Two different extension points; see
[`./adapters.md`](./adapters.md#adapter-vs-plugin) for the contrast.

| Adapter                                  | Plugin                                              |
| ---------------------------------------- | --------------------------------------------------- |
| Drives a specific CLI agent              | Extends the swarm kernel                            |
| Installed via `agentproto install`       | Installed via `agentproto plugins install`          |
| Used by `run`, `sessions`, `agent-cli` swarm executor | Used by `run-swarm` substrate / dispatcher / executor / state |
| Examples: claude-code, hermes, goose     | Examples: guilde-mcp substrate, db-operator         |

You can hold both — a Guilde swarm uses the `@guilde/agentproto-bridge`
plugin to talk to the conversation AND the `claude-code` adapter to
drive participants whose `executor: agent-cli`.

## Where the manifest lives

The CLI tolerates two locations per plugin:

```jsonc
// 1. Embedded in package.json — npm-native, default
{
  "name": "@your/agentproto-thing",
  "agentproto": {
    "schema": "agentproto/plugin/v1",
    "substrates": [ … ],
    "executors": [ … ]
  }
}

// 2. Standalone agentproto.json next to package.json — wins if both exist
```

Use the embedded form unless your manifest grows long enough to clutter
package.json.

## Config keys

`~/.agentproto/config.json` carries the enabled-plugins list:

```jsonc
{
  "plugins": [
    "@guilde/agentproto-bridge",
    "@acme/agentproto-slack"
  ]
}
```

`agentproto plugins install` appends; `uninstall` / `disable` removes.
Plugins load in array order on every `run-swarm` invocation — last
write wins on duplicate kinds, which lets you override a built-in
with a custom implementation.

## Per-invocation override

Skip the config and load a plugin for one run:

```bash
agentproto run-swarm --plugin @acme/agentproto-experimental \
  --manifest .runtime/multi-agent.yaml
```

Multiple `--plugin` flags allowed; they're appended after anything in
the config.
