# Architecture — @agentproto/agent-runtime

A small port/adapter kernel for running swarms of agents over swappable
conversation substrates. The kernel is transport-agnostic — it knows
nothing about specific chat servers, dispatchers, or executors; it only
routes through port interfaces.

## The one cycle

```
                ┌───────────────────┐
                │   substrate.read  │   1. snapshot recent turns
                └─────────┬─────────┘
                          │
                          ▼
            ┌───────────────────────────┐
            │  dispatcher.selectNext()  │   2. decide who speaks next
            └─────────────┬─────────────┘
                          │ participantIds[]
              ┌───────────┴───────────┐
              │                       │
              ▼                       ▼
   ┌──────────────────┐    ┌──────────────────┐
   │   state.read(p)  │    │ executor.execute │   3. produce reply
   └────────┬─────────┘    │       Turn       │
            │              └────────┬─────────┘
            └──────────► input ─────┘
                                    │
                                    ▼
                       ┌────────────────────────┐
                       │   substrate.append()   │   4. write reply turn
                       └────────────┬───────────┘
                                    │
                                    ▼
                         ┌─────────────────────┐
                         │   state.write(p)    │   5. persist state diff
                         └──────────┬──────────┘
                                    │
                                    ▼
                       ┌────────────────────────┐
                       │  lifecycle.onTurnEnd   │   6. fire hooks
                       └────────────────────────┘
```

`runTurn(ports, opts)` executes one cycle. Callers loop it for
continuous operation. The kernel has no concept of "running" — it's
strictly synchronous-per-cycle. Long-running behavior lives in the
caller (the `agentproto run-swarm` verb wraps it in a `do-while`).

## Ports

### `Substrate`

The conversation store. Append-only, oldest-first read semantics.

```ts
interface Substrate {
  readonly kind: string
  append(turn: TurnInput): Promise<Turn>
  read(since?: TurnId): Promise<readonly Turn[]>
}
```

Reference adapter: `FileSubstrate` — a markdown journal at a path. Each
turn is delimited by `=== TURN id=… participant=… ts=… ===`.

Other implementations: chat servers (Slack, Discord), MCP-bridged
threads, REST APIs. Ship as plugin packages.

**`since` contract:** if `since` is provided but not in the window the
adapter fetched, the adapter SHOULD throw (telling the caller to raise
its fetch window) rather than silently returning everything — otherwise
the dispatcher's cursor can re-fire on already-handled turns.

### `Dispatcher`

Decides which participants speak next, given the recent turns and the
participant roster.

```ts
interface Dispatcher {
  readonly kind: string
  selectNext(input: DispatcherInput): Promise<readonly ParticipantId[]>
}
```

Reference adapter: `MentionDispatcher` — selects participants whose
`displayName` is `@-mentioned` in the most recent turn. Tracks an
in-memory cursor so it doesn't re-fire on the same trigger across
cycles.

Other implementations: round-robin, topic-routed, LLM-decided. The
dispatcher is the pluggable "who speaks next?" decision.

### `ParticipantExecutor`

Produces a turn for a given participant when the dispatcher selects
them.

```ts
interface ParticipantExecutor {
  readonly kind: string
  executeTurn(input: ParticipantExecuteInput): Promise<ParticipantExecuteOutput>
}
```

Reference adapter: `AgentCliParticipant` — spawns a CLI binary (`claude
--print`, `hermes -p`, etc.), pipes the assembled prompt over stdin,
returns parsed stdout as the turn body.

Other implementations: in-process LLM SDK calls, server-side delegation
(e.g. MCP `run_operator`), webhook-driven external workers.

Each participant in the manifest declares an `executor` kind; the
runtime keeps one executor instance per kind, shared across
participants of that kind.

### `StateStore`

Per-participant scratch state, persisted across turns.

```ts
interface StateStore {
  readonly kind: string
  read(participantId: ParticipantId): Promise<Readonly<Record<string, unknown>>>
  write(participantId: ParticipantId, state: Readonly<Record<string, unknown>>): Promise<void>
}
```

Reference adapter: `FileStateStore` — one JSON file per participant.

The state is what the executor returns in `stateUpdate`; the kernel
writes it after the substrate append. Useful for executors that
maintain working memory between turns (counters, scratchpads,
operator-context summaries).

### `Lifecycle` (optional)

Sparse hooks fired at the edges of a cycle. Adapters opt in by
implementing some/all callbacks.

```ts
interface Lifecycle {
  onTurnEnd?(turn: Turn): Promise<void> | void
  onMention?(target: ParticipantId, byTurn: Turn): Promise<void> | void
  onIdle?(): Promise<void> | void
}
```

Useful for: domain hooks where the caller needs to react to a turn
(e.g. mirror it elsewhere). For structured observability of every
phase boundary, use the `Telemetry` port below instead.

### `Telemetry` (optional)

A single sink for structured per-phase events:

```ts
interface Telemetry {
  emit(event: TelemetryEvent): void
}
```

Every event carries `cycleId` + `at`; sinks group on cycleId to
rebuild OTEL-style spans. Event kinds emitted per cycle:
`cycle.started`, `substrate.read`, `dispatch.decided`,
`participant.started`/`finished`/`failed`, `substrate.appended`,
`state.written`, `cycle.idle`, `cycle.finished`.

Reference adapters in
`@agentproto/agent-runtime/adapters/telemetry`:

- `noopTelemetry` — silent default
- `stderrTelemetry({ prefix?, include?, exclude? })` — one human-readable line per event
- `arrayTelemetry()` — in-memory, for tests
- `composeTelemetry(...sinks)` — fan-out

Wire your own (OTEL exporter, JSON-lines log, metrics counter, …) by
implementing the interface. Sinks that throw are isolated — kernel
never crashes a cycle on a telemetry failure.

## Composition

`RuntimePorts` is the tuple the kernel runs against:

```ts
type RuntimePorts = {
  substrate: Substrate
  dispatcher: Dispatcher
  state: StateStore
  lifecycle?: Lifecycle
  participants: readonly ParticipantDescriptor[]
  executors: ReadonlyMap<string, ParticipantExecutor>
}
```

Built by the caller. The reference path is `@agentproto/cli`'s
`run-swarm` verb — it reads a manifest, looks up each `kind` in the
runtime registry (`@agentproto/cli/registry/runtime`), and builds the
ports tuple. The kernel itself never matches `kind` strings; that
happens in the wiring layer.

## Manifest

Markdown with YAML frontmatter (the same doctype convention
`@agentproto` uses elsewhere):

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

Each adapter block (`substrate`, `dispatcher`, `state`) carries a
`kind` plus arbitrary host-extension fields. The validating zod schema
(`manifest.ts`) uses `.loose()` on the adapter blocks — the kind's
factory reads its own typed fields off the block at build time.

## Extension points

### Adding a new substrate / dispatcher / executor / state store

Implement the relevant port interface. Then register through
`@agentproto/cli/registry/runtime`:

```ts
// in your-plugin/src/index.ts
import { registerSubstrate } from "@agentproto/cli/registry/runtime"
import { MySubstrate } from "./my-substrate.js"

registerSubstrate("my-kind", (cfg, ctx) => {
  return new MySubstrate({
    foo: typeof cfg.foo === "string" ? cfg.foo : "default",
    // …
  })
})
```

Users wire it via `--plugin <your-package>` on `agentproto run-swarm`,
or by listing it under `plugins[]` in `~/.agentproto/config.json`.

### Adapter context

Each factory receives an `AdapterContext`:

```ts
interface AdapterContext {
  readonly baseDir: string                          // manifest's dir
  registerCleanup(fn: () => Promise<void> | void): void
}
```

`registerCleanup` is the place to register teardown for adapters that
hold disposable resources (MCP clients, sockets, child processes). The
CLI calls every registered callback in order when the swarm shuts down.

## Invariants

- **The kernel never matches `kind` strings.** It dispatches off the
  port interface (`substrate.append()`, `executor.executeTurn()`, etc.)
  and looks executors up in the `executors` map. Kind resolution
  happens in the wiring layer (the CLI), never in `runtime.ts`.
- **A single cycle is synchronous-per-step.** Substrate append, state
  write, lifecycle hooks run sequentially within a cycle. Concurrency
  across multiple selected participants is intentionally **not**
  provided by the kernel — adapters can parallelise internally if they
  want, but the contract is one-by-one.
- **Failure recovery is the caller's job.** `runTurn` propagates
  exceptions. The CLI's run-loop catches them and continues; a library
  user is free to do anything else.

## What is intentionally NOT in scope

- **Tool / effector binding.** The kernel doesn't model "this
  participant has these tools available." Executors handle that
  themselves — the agent-cli executor passes whatever flags the CLI
  needs; an in-process executor wires tools directly. If structured
  binding becomes useful later, it'd go in `ParticipantDescriptor.meta`
  or via a future `Effector` port.
- **Routing across substrates / federation.** One swarm = one
  substrate. Federation (one operator participating in many
  conversations) is the caller's composition concern.
- **Persistence schemas beyond `StateStore`.** Auditing, tracing,
  evaluation runs — all live outside the kernel.
