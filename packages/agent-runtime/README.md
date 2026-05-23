# @agentproto/agent-runtime

MultiAgentRuntime kernel — a small port/adapter framework for running
swarms of agents over swappable conversation substrates.

**Status:** alpha.

## What this is

A composition primitive, not a product. The kernel knows nothing
about specific transports, dispatchers, or executors — it only routes
through port interfaces. Mode (local file journal, hosted chat,
MCP-bridged thread, …) is decided entirely by the adapters the caller
wires in.

## Ports

| Port                  | What it does                                                        |
| --------------------- | ------------------------------------------------------------------- |
| `Substrate`           | Append-only conversation store. `append(turn)` + `read(since?)`.    |
| `Dispatcher`          | Decides which participants speak next given recent turns.           |
| `ParticipantExecutor` | Produces a turn for a given participant on demand.                  |
| `StateStore`          | Per-participant scratch state across turns.                         |
| `Lifecycle`           | Optional hooks: `onTurnEnd`, `onMention`, `onIdle`.                 |
| `EffectorBinding`     | Optional per-participant tool / MCP bindings (consumer-supplied).   |

A `RuntimePorts` is a tuple of these. `runTurn(ports, options)` runs
one dispatcher cycle:

```
read substrate → dispatch → execute selected participants → append → fire lifecycle
```

Loop it for continuous operation.

## Reference adapters

Shipped in this package under `@agentproto/agent-runtime/adapters/*`:

| Adapter                                              | Kind         | Notes                                              |
| ---------------------------------------------------- | ------------ | -------------------------------------------------- |
| `substrate-file`                                     | `file`       | Append-only markdown journal at a given path.      |
| `dispatcher-mention`                                 | `mention`    | Selects participants @-mentioned in the trigger.   |
| `state-fs`                                           | `fs`         | One JSON file per participant.                     |
| `participant-agent-cli`                              | `agent-cli`  | Spawns a CLI binary (`claude --print`, etc.).      |

## Manifest

A `MultiAgentRuntime` manifest is markdown with YAML frontmatter:

```yaml
---
schema: agentruntimes/v1
kind: MultiAgentRuntime
id: my-swarm
participants:
  - id: reviewer
    executor: agent-cli
    displayName: Reviewer
    role: ../.claude/agents/reviewer.md
substrate:
  kind: file
  path: ./conversation.md
dispatcher:
  kind: mention
state:
  kind: fs
  dir: ./state
---

Free-form documentation of what this swarm does.
```

`@agentproto/cli`'s `run-swarm` verb loads such manifests, resolves
each `kind` string through its adapter registry, and runs cycles in a
loop. Third-party adapters register through `@agentproto/cli/registry/runtime`.

## Extending

Implement any of the ports and ship it as your own package. To plug
into the CLI, export a module that calls `registerSubstrate` /
`registerDispatcher` / `registerExecutor` from
`@agentproto/cli/registry/runtime` at load time, then point users at
it with `--plugin <your-module-id>` or via `~/.agentproto/config.json`.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the port-by-port walk,
cycle diagram, and invariants.

## License

MIT.
