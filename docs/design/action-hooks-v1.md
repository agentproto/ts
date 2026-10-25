# Action hooks v1: contract and compatibility inventory

Status: PR 1 contract freeze. No runtime dispatcher is wired in this change.
The TypeScript surface is the `action-hooks/v1` contract module in
`@agentproto/lifecycle` (`src/hooks.ts`, re-exported from the package root).
The AIP-71 reference implementation is the daemon runtime; this package holds
the contract parser and the AIP-37 event names.

This document freezes terminology and records the surfaces that later PRs
must connect. It deliberately does not add an outbox, a prompt queue, a
second action registry, or a new capability tool.

## Why three paths instead of one callback

`action-hooks/v1` names three execution paths. They have different timing,
different failure semantics, and different config sources. Collapsing them
into one callback would force admission to be asynchronous, or reactions to
be best-effort, which is wrong for both.

| Path | When it runs | Result | Durability |
| --- | --- | --- | --- |
| `admission` | Before a daemon-owned action is invoked | Authorization (allow or deny) is an AIP-38 policy decision over the AIP-39 action id and runs first; an admission hook can only narrow it, and the host may also return `reuse` or `defer`; a native harness hook can express only allow and deny | No receipt; the action either proceeds or does not |
| `lifecycle` | After a state transition | Non-blocking event emission | Best-effort; observers may miss it |
| `reaction` | After an event is accepted | Invokes an action | Best-effort by default; durable only when the host has a durable store and the action is idempotent or otherwise safe to replay |

The contract does not build one universal callback. It also does not add a
second prompt queue. A reaction that needs a model turn must use the existing
session and prompt path.

## Frozen terms

- **Event ref**: an AIP-37 lifecycle event name used as a key. Standard
  names (`turn-end`), aliases (`per-turn`), templated names (`idle-300`), and
  explicitly registered host events (`agentproto:*`) are allowed.
- **Action ref**: an AIP-39 action id. Resource-qualified ids such as
  `session:child-housekeeping` are preferred; unqualified ids remain valid.
- **Admission hook**: a policy evaluation bound to one action, before the
  action runs.
- **Lifecycle emission**: an event fired after a daemon-owned transition.
  It never waits for subscribers.
- **Reaction**: an event ref bound to one or more action refs.
- **Receipt**: the record that a reaction was attempted and what happened.
  A receipt is not an outbox and is not a delivery guarantee.
- **Reconciliation**: recovery work for a reaction whose outcome is unknown.
  It is only allowed where replaying the action is safe.
- **Host event registration**: an explicit declaration that makes a
  nonportable host event usable in configs.

## Event refs: portable by default

Portable configs use AIP-37 names directly. Aliases resolve to their
canonical event. Templated events retain their numeric threshold.

Host-specific events are namespaced, for example
`agentproto:child-housekeeping`. They are nonportable and must be registered
explicitly before a config may reference them. An unregistered namespaced
event is a contract error, not a silently accepted typo. AIP-37 also permits
hosts to fire additional bare event names; `action-hooks/v1` preserves those as custom
portable references.

The runtime's `SessionEventType` union uses transport-local names such as
`session:turn-end`. Those names are not the portable config vocabulary.
Adapters translate between the AIP-37 name in a config and the daemon's
internal event stream. This contract does not rename any existing event.

## Action refs: resource kinds, not host namespaces

Action ids follow AIP-39. Prefer a resource-kind prefix such as
`session:child-housekeeping`, not `agentproto:child-housekeeping`.
`agentproto` is an event host namespace, and using it as a target kind makes
the binding look like a host callback instead of an action on a resource.

A string is the shorthand. An AIP-42 `actionRef` object may use `action` or
`ref`, plus optional `inputs`. Setting both `action` and `ref` is rejected
because the intent is ambiguous.

## AIP-42 `on:` is the agent-manifest configuration layer

`AGENT.md` already defines `on:` as "AIP-37 event name -> action-ref(s) to
invoke". `action-hooks/v1` treats that map as its agent-manifest configuration
layer. It is not a competing hook system.

Example:

```yaml
on:
  turn-end: session:child-housekeeping
  idle-300:
    - session:child-housekeeping
```

`parseAgentHookMap` validates and normalizes the shorthand into reaction
records. Because the shorthand has no delivery fields, every normalized
reaction is `delivery: "best-effort"` and `reconciliation: "none"`.

Compatibility note: `AGENT.schema.json` constrains `on:` values to an
actionRef or an array of actionRefs, but the generated zod schema currently
collapses actionRef to `any`. Malformed values can therefore pass manifest
parsing today. `parseAgentHookMap` is the stricter opt-in contract. No
runtime path calls it in this PR, and existing AGENT.md loads behave exactly
as before.

## AIP-41 event routines are a second configuration surface, not a second system

AIP-41 permits `schedule.kind: "event"` with `schedule.on` and an optional
filter. That is a reaction declaration. The runtime currently parses and
validates those routines but does not register them: `routine-registrar.ts`
only registers enabled routines whose schedule kind is `cron`. Even for cron,
`target.action` is validated but not dispatchable because no AIP-39 action
resolver is wired. Event routines and action targets are skipped today, not
silently executed.

An illustrative strict routine frontmatter. Note that `description` is
required by ROUTINE.schema.json:

```yaml
---
schema: routine/v1
id: child-housekeeping-on-turn-end
description: Reconcile child sessions after each completed turn.
version: 1.0.0
schedule:
  kind: event
  on: turn-end
  filter:
    awaitingInput: false
target:
  action: session:child-housekeeping
  inputs:
    dry_run: false
enabled: true
---
```

The same parsing function must preserve non-action event routines, such as
those targeting a tool or workflow. `action-hooks/v1` only freezes the action-target
shape; it does not invalidate other AIP-41 targets.

## Existing `.agentproto/hooks.json` is not this contract

`packages/runtime/src/hooks-config.ts` already implements a semantic hook
engine at the ACP permission seam. Its actions are `log`, `allow`, `hold`,
`deny`, and `gate`; rules carry `plane` and `intent`. That engine is
admission-adjacent, but it is a separate, existing surface.

Do not rename it to `action-hooks/v1`, do not make it the universal reaction
dispatcher, and do not merge its rule shape into AIP-42 `on:` in PR 1.
The daemon's `clerk-turn-end` hook documented in `docs/clerk-hook.md` is
also unchanged.

## Capability inventory stays on existing surfaces

There is no `hooks_capabilities` tool. When hooks support is advertised, it
belongs in the existing surfaces:

- `harness_capabilities` for harness-level support.
- `session_capabilities` for session-level support.

The concrete advertisement shape is intentionally deferred until a runtime
implementation extends these frozen responses. PR 1 does not modify either
response body.

## Durability and reconciliation are explicit, not implied

The session event bus is in memory. There is no transactional outbox, and
this contract does not pretend there is one.

Consequences:

- A `best-effort` reaction may be lost on restart. That is the only honest
  default for today's bus.
- A `durable` receipt is valid only when the host actually writes it to a
  durable store.
- `reconciliation: "safe"` is valid only for an action whose replay is
  idempotent or otherwise safe. A receipt plus reconciliation is not
  exactly-once delivery.
- A reaction with an unknown outcome must not be blindly replayed when the
  action mutates external state.

## Context emergency rescue remains core

Context emergency rescue (`session:context-rescue`) stays a core daemon
behavior. `action-hooks/v1` does not move it behind admission, does not require a
reaction receipt for it, and does not make its operation conditional on a
hook config. Deleting the context ladder is a separate migration and is out
of scope for this contract.

## Compatibility inventory

| Surface | Current behavior | action-hooks/v1 relationship |
| --- | --- | --- |
| `packages/lifecycle/src/index.ts` | AIP-37 event vocabulary, aliases, templated names | Source of portable event refs |
| `packages/action/src/schema.ts` | AIP-39 `<target-kind>:<verb>` action ids | Source of action-ref shape |
| `packages/agent/src/schema.ts` | AIP-42 `on:` map, values currently loose after zod generation | Agent-manifest config layer; opt-in strict parser in this PR |
| `packages/agent/src/load-agent.ts` | Loads and validates AGENT.md | Unchanged; no dispatcher call added |
| `packages/routine/src/schema.ts` | AIP-41 schedule and target validation | Event-routine config layer |
| `packages/runtime/src/routine-registrar.ts` | Registers cron jobs; event routines resolve to reaction bindings; `target.action` is skipped without a registered handler | Event routines now fire through the reaction runner; `action` arms remain the documented gap |
| `packages/runtime/src/session-event-bus.ts` | In-memory `SessionEventType` pub/sub | Transport for lifecycle and reaction paths; not portable config names |
| `packages/runtime/src/hooks-config.ts` | Existing semantic ACP permission hook engine | Separate surface; not renamed or merged |
| `packages/runtime/src/capabilities-inventory.ts` | Existing MCP/skill inventory | Future host-level hook capability advertisement would extend existing capabilities surfaces |
| `packages/runtime/src/sentinel-webhook-outbox.ts` | Existing durable outbox precedent | Future reaction receipts must generalize or reuse this pattern, not introduce a parallel durability system |
| `packages/runtime/src/session-capabilities.ts` | Frozen session capability response | Future optional additive hook block; unchanged in PR 1 |

## Out of scope for PR 1

- Any dispatcher, scheduler, subscriber, outbox, or receipt store.
- Any change to `AGENT.md` or `ROUTINE.md` parsing behavior.
- Any change to `session_capabilities` or `harness_capabilities` output.
- Any change to context rescue or the context ladder.
- Any change to the existing `.agentproto/hooks.json` engine or clerk hook.
