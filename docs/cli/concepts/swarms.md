# Swarms

A **swarm** is a manifest plus a kernel-driven cycle: read the
conversation substrate → ask the dispatcher who speaks next → execute
each selected participant → append their reply → fire lifecycle
hooks. `agentproto run-swarm` runs that loop.

The kernel itself lives in
[`@agentproto/agent-runtime`](https://www.npmjs.com/package/@agentproto/agent-runtime).
The CLI is the wiring layer — it reads the manifest, resolves every
adapter kind through the [plugin registry](./plugins.md), and feeds
the resulting ports tuple into `runTurn(ports)`.

## The cycle

```
  read substrate
       │
       ▼
  dispatch ── selected participants? ──no──▶ idle
       │ yes
       ▼
  for each selected:
    execute → append → state.write → onTurnEnd
       │
       ▼
  cycle.finished
```

Per the kernel's
[`ARCHITECTURE.md`](https://github.com/agentproto/ts/blob/main/packages/agent-runtime/ARCHITECTURE.md):

- The kernel never matches `kind` strings — that happens in the CLI's
  wiring layer.
- One cycle = one synchronous pass. The CLI's run-loop wraps `runTurn`
  in a `do-while` for continuous operation.
- Failure recovery is the caller's job — `runTurn` propagates errors
  and the CLI logs + continues.

## Manifest

A manifest is markdown with YAML frontmatter:

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

Every `*.kind` resolves through the registry. Built-ins: `file`
(substrate), `mention` (dispatcher), `fs` (state), `agent-cli`
(executor). Other kinds come from installed plugins —
[`agentproto plugins show <pkg>`](../verbs/plugins.md) prints what
each plugin declares.

See [`verbs/run-swarm.md`](../verbs/run-swarm.md) for the verb itself.

## File mode vs transport-bridged

**File mode** (the default and only built-in) uses a local append-only
markdown journal at `.runtime/conversation.md`. No network, no remote
state, fully offline. Pair with the
[`runtime-profile/standard`](./runtime-profiles.md) profile for ready-
to-go Claude Code scaffolding.

**Transport-bridged** swaps the `substrate` block for a plugin-
provided one (e.g. `kind: guilde-mcp` from
`@guilde/agentproto-bridge`). Same kernel, same dispatcher, same
manifest shape — only the substrate changes. Multiple machines can
participate in the same conversation because the substrate is server-
side.

## Participants

Each participant declares:

- `id` — slug used in mention text and state file naming
- `executor` — kind that drives the participant (built-in `agent-cli`
  spawns a CLI binary; plugins add others like `db-operator`)
- `displayName` — what mentions look like (`@<displayName>`)
- `role` — inline string OR a `.md` path (e.g.
  `../.claude/agents/reviewer.md`); the agent-cli executor reads
  this and feeds it to the spawned agent as the system role
- `meta` — adapter-specific config (e.g. db-operator reads
  `meta.operatorId`)

A participant's `role` is a swarm-manifest concept — the system
prompt text/file fed to that participant — distinct from
`agent_start`'s spawn-time `role` (`executor`/`supervisor`/…), which
gates whether a spawned agent may itself delegate. See
[concepts/roles.md](./roles.md).

## Dispatchers

The dispatcher decides who speaks next given the recent turns. The
built-in `mention` dispatcher selects participants whose `displayName`
appears as `@<name>` in the most recent turn. Other dispatchers
(round-robin, topic-routed, LLM-decided) ship as plugins.

## Observability

When `--verbose` is set, `run-swarm` wires the kernel's
[Telemetry port](https://github.com/agentproto/ts/blob/main/packages/agent-runtime/ARCHITECTURE.md#telemetry-optional)
to `stderrTelemetry`, printing one structured line per phase boundary:

```
agentproto run-swarm: c_a9ab02f5cb14 cycle.started
agentproto run-swarm: c_a9ab02f5cb14 substrate.read file turns=1 1ms
agentproto run-swarm: c_a9ab02f5cb14 dispatch.decided mention selected=[reviewer] 0ms
agentproto run-swarm: c_a9ab02f5cb14 participant.started reviewer (agent-cli)
agentproto run-swarm: c_a9ab02f5cb14 participant.finished reviewer 5258ms content=2b
agentproto run-swarm: c_a9ab02f5cb14 substrate.appended turn=t_98917a09a2b3 by=reviewer
agentproto run-swarm: c_a9ab02f5cb14 cycle.finished executed appended=1 5260ms
```

Each event carries a per-cycle `cycleId` so a downstream sink (custom
exporter, OTEL) can rebuild span trees by grouping.
