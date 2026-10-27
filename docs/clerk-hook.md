# The clerk hook (AIP-68)

The **clerk** is the daemon-side steward/secretary: when a session finishes a
turn, the daemon may - after an idle pause - run ONE clerk pass over that
session's context (is it done? stuck? waiting for something?). The
`clerk-turn-end` hook is the daemon subscriber that does this.

It is **disabled by default**. A daemon that never heard of AIP-68 never
runs an extra pass on its own.

## What it does

| Property | Behaviour |
| --- | --- |
| Trigger | `session:turn-end` on the session-event bus |
| Debounce | Per session: every turn-end restarts the timer; the pass runs once the session has been quiet for `debounceMs` (default **10 min**, AIP-68 §3.6) |
| Single-flight | Never two passes on the SAME session at the same time - a timer that fires while a pass is running is a no-op (the next turn-end re-arms it) |
| Fire-and-forget | The pass is launched, never awaited: a slow or hanging pass can never slow a turn down, let alone block it |
| Disabled by default | The resolved configuration's `enabled` decides |

The clerk ignores:

- **its own sessions** - the sessions the clerk itself runs in (a clerk never
  grades its own homework);
- **empty turns** - a turn with no assistant output and no tool call is not a
  session that needs stewarding;
- **interrupted turns** - the daemon cut them off, they never really ended;
- **excluded sessions** - by id, label, title, slug or origin;
- **non-agent sessions** - `kind !== "agent-cli"`.

## Configuration - three levels, most specific wins

The configuration is merged **per field** from three levels, from the most
general to the most specific. A level only overrides a field it actually
states, so an agent that sets `enabled` alone still inherits the workspace's
`debounceMs` and `run`.

| Level | Where | Notes |
| --- | --- | --- |
| 1. daemon | `~/.agentproto/config.json` → `daemon.clerk` | The most general. Unset ⇒ the built-in default (disabled) |
| 2. workspace | `<workspace>/.agentproto/hooks.json` → `hooks.clerk` | The same file that already carries the semantic hook rules |
| 3. agent | the agent manifest's `metadata.hooks.clerk`, or an `agent_start` option's `hooks.clerk` | The most specific - it always wins |

### Fields

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Whether the hook fires at all |
| `on` | `"turn_end"` | `"turn_end"` | The event the hook is bound to |
| `debounceMs` | number | `600000` (10 min) | Idle debounce before the pass runs |
| `run.routine` | string | `"steward"` | An AIP-41 routine the pass triggers |
| `run.command` | string | - | A shell command the pass runs instead of a routine. Must pass the command allowlist (`.agentproto/allowed-commands.json`), same as `command_execute`; default-deny |
| `run.args` | string[] | - | argv for `run.command`; `$SESSION_ID` is replaced by the id of the session the pass runs for |
| `run.cwd` | string | the session's cwd | Working directory for `run.command`, anchored under the session's cwd |
| `run.timeoutMs` | number | - | Hard cap on the pass's runtime |
| `exclude` | string[] | - | Sessions the hook never touches (id / label / title / slug / origin) |

### Examples

Workspace level - `<workspace>/.agentproto/hooks.json`:

```json
{
  "rules": [],
  "hooks": {
    "clerk": {
      "enabled": true,
      "on": "turn_end",
      "debounceMs": 600000,
      "run": { "routine": "session-steward-hourly" },
      "exclude": ["sess_noisy"]
    }
  }
}
```

The generic PR #2142 vocabulary works too (`hooks.enabled`, `on: "turn_end"`)
when there is no `hooks.clerk`:

```json
{ "hooks": { "enabled": true, "on": "turn_end", "debounceMs": 300000 } }
```

Agent level - an `agent_start` option:

```json
{ "hooks": { "clerk": { "enabled": true, "debounceMs": 600000 } } }
```

Agent level - an agent manifest (`AGENT.md`):

```yaml
---
schema: agent/v1
id: reviewer
description: Reviews pull requests.
model: openai/gpt-5
metadata:
  hooks:
    clerk:
      enabled: true
      debounceMs: 900000
      run:
        command: agentproto
        args: ["steward", "act", "--session", "$SESSION_ID"]
---
```

Daemon level - `~/.agentproto/config.json`:

```json
{ "daemon": { "clerk": { "enabled": true, "debounceMs": 600000 } } }
```

## Durable dispatch (opt-in)

By default the firing of a debounce timer calls the legacy pass runner
directly. A workspace can hand its clerk passes to the durable reaction path
instead by listing its slug in `defaults.reactions.clerk.workspaces`:

```json
{ "defaults": { "reactions": { "clerk": { "workspaces": ["my-workspace"] } } } }
```

What changes for a listed workspace:

- each firing emits the host event `agentproto:clerk-due` and writes a
  receipt under `~/.agentproto/reaction-receipts/<bucket>.json`;
- the pass runs through the reaction runner, so a pass that throws (a refused
  command, a failed spawn) is retried with backoff, up to 3 attempts in total;
- a `run.command` that runs but exits with a non-zero code, or is killed by
  its timeout, is not retried (the pass is not idempotent): the receipt ends
  `dead` with the exit code as its reason. The legacy path still ignores the
  exit code;
- boot reconciliation marks a stale `pending` receipt `dead` with
  `stale_trigger` (the session is gone) and does not replay a `running`
  receipt because the pass target is not idempotent;
- the binding appears in `GET /reactions` visibility like the other builtin
  bindings.

What does not change:

- the controller stays the gate: its ignore rules, its per-session debounce
  timer and its config resolution are untouched;
- single-flight per session still holds, but for a listed workspace it is
  enforced inside the pass target rather than by the controller (the
  controller returns as soon as the event is emitted): a second concurrent
  pass for the same session is recorded as done with the outcome
  `skipped:single_flight` and runs nothing;
- the firing that reaches the reaction is already debounced, and ownership is
  read once for that firing, so a workspace never runs both paths for the
  same firing.

Rollback: remove the slug from `defaults.reactions.clerk.workspaces`. The key
is hot, so the next firing uses the legacy dispatch again.

Limits:

- the debounce timer stays in memory: a restart drops a pending debounce
  exactly as before;
- a pass interrupted by a crash is not replayed;
- a failed dispatch is retried up to 3 times with backoff.

## Implementation

- `packages/clerk/src/clerk-turn-end.ts` - the controller (debounce,
  single-flight, fire-and-forget, the ignore rules).
- `packages/clerk/src/clerk-hook-config.ts` - the three-level resolution,
  the per-field merge and the config shapes.
- `packages/clerk/src/clerk-pass-runner.ts` - what a pass launches: an
  AIP-41 routine (through the daemon's routine registrar) or a detached
  shell command.
- `packages/runtime/src/action-hooks/clerk-reaction.ts` - the opt-in durable
  reaction and the dispatch the controller calls.

The daemon wires the controller at boot (`packages/runtime/src/index.ts`) and
disposes it on shutdown, cancelling every pending debounce timer.

## `run`: one arm, most specific level wins

`run.routine` and `run.command` are mutually exclusive arms. A level that
names one arm replaces the other arm entirely (so an agent that only names a
`command` does not keep the built-in `steward` routine); a level naming both
keeps the routine. `run.cwd` and `run.timeoutMs` are options of the pass and
are inherited field by field. In the resolved provenance, `sources.run` is
the level that chose the arm.

## Recursion guard

A session spawned by the clerk's own routine carries `origin:
"routine:<id>"`; the controller ignores it, so its turn-end never re-arms a
pass. A fresh continuation (`session_continue_fresh`) keeps the agent-level
hook config of the session it replaces.
