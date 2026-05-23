# Plugins

`@agentproto/cli` is extensible. Plugins ship adapters — substrates,
dispatchers, participant executors, state stores — that the kernel
wires into a swarm via the manifest's `kind` strings.

This document covers:
- How to declare what a plugin provides (the manifest)
- How to publish + install one
- How to manage installed plugins from the CLI

## Plugin manifest

Plugins declare what they provide in either:

1. **`package.json#agentproto`** (recommended — npm-native), or
2. **`agentproto.json`** next to `package.json` (standalone — preferred
   if the block grows long).

The CLI reads whichever it finds (standalone wins if both exist),
validates it against the `agentproto/plugin/v1` schema, and registers
each declared adapter with the runtime registry.

### Shape

```jsonc
{
  "name": "@your-org/agentproto-something",
  // …
  "agentproto": {
    "schema": "agentproto/plugin/v1",
    "substrates": [
      {
        "kind": "your-substrate-kind",
        "entry": "./dist/index.mjs",
        "export": "yourSubstrateFactory",
        "capabilities": ["mentions", "reactions"],
        "description": "Optional human-readable summary."
      }
    ],
    "dispatchers": [
      {
        "kind": "your-dispatcher-kind",
        "entry": "./dist/index.mjs",
        "export": "yourDispatcherFactory",
        "description": "Optional."
      }
    ],
    "executors": [
      {
        "kind": "your-executor-kind",
        "entry": "./dist/index.mjs",
        "export": "yourExecutorFactory"
      }
    ],
    "stateStores": [
      {
        "kind": "your-state-kind",
        "entry": "./dist/index.mjs",
        "export": "yourStateStoreFactory"
      }
    ]
  }
}
```

Each adapter entry needs:

| Field | Required | Meaning |
|-------|----------|---------|
| `kind` | yes | The string a manifest's `substrate.kind` / `dispatcher.kind` / etc. matches. Must be unique within an adapter category. |
| `entry` | yes | Path to the module exporting the factory, relative to the package root. Use a `./dist/...` build output, not `./src/...` raw TS. |
| `export` | yes | Named export — the factory function. |
| `description` | no | One-line summary surfaced by `agentproto plugins show`. |
| `capabilities` | no, substrates only | Free-form tag list (`mentions`, `reactions`, `visibility`, `identity`, `multi-writer`, `ordered`, …). Not enforced today, surfaced for users. |

### Factory signatures

A factory takes the loose adapter config from the manifest plus a
shared adapter context, and returns the implementing instance. From
`@agentproto/cli/registry/runtime`:

```ts
type SubstrateFactory = (
  config: AdapterConfig,
  ctx: AdapterContext
) => Promise<Substrate> | Substrate

type DispatcherFactory  = (config: AdapterConfig, ctx: AdapterContext) => Promise<Dispatcher>  | Dispatcher
type ExecutorFactory    = (config: AdapterConfig, ctx: AdapterContext) => Promise<ParticipantExecutor> | ParticipantExecutor
type StateStoreFactory  = (config: AdapterConfig, ctx: AdapterContext) => Promise<StateStore>  | StateStore

interface AdapterConfig {
  readonly kind: string
  readonly [extension: string]: unknown   // host-extension fields from the manifest
}

interface AdapterContext {
  readonly baseDir: string                              // manifest's directory (for path resolution)
  registerCleanup(fn: () => Promise<void> | void): void // teardown for disposable resources
}
```

Each factory validates the fields it cares about off `config` inline
(typed-narrowing on `typeof config.foo === "string"` etc.) and uses
`ctx.registerCleanup` to register any teardown.

### Minimal example

A plugin that adds a `null` substrate (drops every append, returns
empty reads — useful for tests):

```ts
// src/index.ts
import type {
  AdapterContext,
  SubstrateFactory,
} from "@agentproto/cli/registry/runtime"
import type { Substrate, Turn, TurnInput } from "@agentproto/agent-runtime"

class NullSubstrate implements Substrate {
  readonly kind = "null"
  async append(turn: TurnInput): Promise<Turn> {
    return {
      id: "null",
      participantId: turn.participantId,
      content: turn.content,
      timestamp: new Date().toISOString(),
    }
  }
  async read(): Promise<readonly Turn[]> {
    return []
  }
}

export const nullSubstrateFactory: SubstrateFactory = () => new NullSubstrate()
```

```jsonc
// package.json
{
  "name": "@you/agentproto-null",
  "main": "./dist/index.mjs",
  "agentproto": {
    "schema": "agentproto/plugin/v1",
    "substrates": [
      {
        "kind": "null",
        "entry": "./dist/index.mjs",
        "export": "nullSubstrateFactory",
        "description": "No-op substrate — appends discarded, reads always empty."
      }
    ]
  }
}
```

## Installing & managing plugins

The user-facing flow goes through `agentproto plugins`:

```bash
# Install a plugin (npm i + add to ~/.agentproto/config.json)
agentproto plugins install @guilde/agentproto-bridge

# What's enabled?
agentproto plugins list

# What does a plugin provide?
agentproto plugins show @guilde/agentproto-bridge

# Disable without uninstalling
agentproto plugins disable @guilde/agentproto-bridge

# Re-enable
agentproto plugins enable @guilde/agentproto-bridge

# Fully remove
agentproto plugins uninstall @guilde/agentproto-bridge
```

Plugins are loaded by `agentproto run-swarm` in the order they appear
in `~/.agentproto/config.json` → `plugins[]`. Last-write-wins on
duplicate `kind`s — useful for overriding a built-in.

You can also pass `--plugin <id>` directly to `run-swarm` for a
single-invocation override.

## Where to publish

Per the
[ecosystem naming conventions](./ARCHITECTURE.md) used in this repo:

- **`@agentproto/adapter-<name>`** — reserved for adapters blessed by
  agentproto-org for generic protocols (Slack, Discord, MCP-as-substrate).
- **`@<vendor>/agentproto-<name>`** — vendor-owned integrations (e.g.
  `@guilde/agentproto-bridge`, `@notion/agentproto-pages`).
- **`<name>-agentproto-plugin`** — unscoped community contributions.

The CLI doesn't care about scope — anything `npm install`-able with a
valid manifest works. The conventions exist for human discoverability.

## Legacy: side-effect imports

Before manifests, plugins self-registered by calling
`registerSubstrate(...)` etc. at module load. The loader still
supports this path: if a plugin has no manifest, the CLI falls back to
`await import(pluginId)` and trusts the plugin to register on its own.

New plugins should use the manifest. The side-effect path will stay
supported through the v0.x cycle but may be removed at v1.0 — the
manifest approach is strictly better (introspectable, doc-friendly,
no hidden state at module-load time).
