---
name: ap-reactions
description: Make the daemon react when a session completes, with restart-safe receipts and no duplicates: event routines (schedule.kind event) and AGENT.md on maps that fire a registered action such as session:archive, the per-workspace opt-in brain-ingest and clerk reactions, and GET /reactions to read health. Trigger when asked to archive finished child sessions automatically, run something on session completion, check why a reaction did not fire, read reactions.refused, or move brain ingest or the clerk pass onto the durable path.
---

# ap-reactions

## When to use

- Something must happen **after a session completes**, exactly once per completion, even if the daemon restarts in between (archive a finished child, ingest into the brain, run a post-turn pass).
- You need to know **why a reaction did not fire**, or whether the durable path is healthy.
- Not for time-based work (use `ap-cron`), not for gating a tool call or a spawn before it runs (reactions run after the event, they cannot veto), and not for one-off waiting on a session (use `ap-wait-durable`).

## The model in four lines

1. An **event** happens. Today the only event a routine or an `on` map can use is `agentproto:session-completed`: a session is terminal AND its outcome says completed (declared, steward verdict, operator "mark as completed") or a completion policy passed. It fires once per terminal transition.
2. A **binding** (an event routine, an `AGENT.md` `on` entry, or a builtin) matches it.
3. The runner writes a **receipt** keyed `<session>/<event>/<occurrence>/<binding>` before it runs the target. The same completion delivered twice runs once.
4. The **action** runs. A failure is retried up to 3 times. After a crash, a receipt left `running` is replayed at boot only if the action is idempotent; a non-idempotent one is logged as stuck and not replayed.

A session that a reaction starts is stamped with origin `reaction:<binding>` and a depth; the chain stops at depth 4 (receipt `dead`, reason `recursion_cap`).

## Actions you can name

Only actions registered in the daemon can be named. Anything else is refused and listed under `reactions.refused`.

| Action | What it does |
| ------ | ------------ |
| `session:archive` | Archives the session of the event. Idempotent. Skips (receipt still `done`, with an `outcomeRef`) when the session is missing, already archived, alive, pinned or `keepAlive`: `skipped:session_missing`, `skipped:already_archived`, `skipped:alive`, `skipped:pinned`, `skipped:keep_alive`. A session with a successor is archived too. |
| `session:clerk-pass` | Runs the AIP-68 clerk pass. Reachable only through the builtin clerk reaction (see below), not nameable from a routine. |

A routine can also use a `tool`, `workflow` or `agent` target, but those arms get **no event context**: they cannot know which session just completed. Use an action when the target depends on the session of the event.

## Recipe 1: archive finished child sessions (event routine)

Create `<workspace>/.routines/archive-finished-children/ROUTINE.md`:

```yaml
---
schema: routine/v1
id: archive-finished-children
description: Archive a child agent session once it has completed, so it leaves the default session list.
schedule:
  kind: event
  on: agentproto:session-completed
  filter:
    session.isChild: true
target:
  action: session:archive
---
```

Then call `routine_reconcile` (or `POST /routine-defs/reconcile`). In the result, `reactions.active` must contain `routine:archive-finished-children` and `reactions.refused` must not. Rollback: `enabled: false` and reconcile; already archived sessions stay archived (`session_unarchive` restores one).

`filter` is flat dotted paths with strict equality, all entries must match, and a missing path never matches:

| Path | Value |
| ---- | ----- |
| `session.kind` | descriptor kind |
| `session.isChild` | true when the session has a parent |
| `session.workspaceSlug` | workspace slug |
| `session.origin` | spawn origin |
| `session.adapter` | adapter slug |
| `session.label` | session label |
| `session.agentId` | AIP-42 manifest id the session was started from (owner prefix stripped) |
| `session.reactionDepth` | depth of the reaction chain, as a number |
| `session.causedByEventId` | id of the event that caused the session |

## Recipe 2: `on` map in an `AGENT.md`

```yaml
on:
  agentproto:session-completed: session:archive
```

It applies **only to the sessions started from that agent** (`meta.agentId` equals the manifest id). A value is a string, an object `{ action, inputs }`, or an array of those. Every reconcile rescans `<workspace>/.agents/*/AGENT.md`, so an edit takes effect on the next reconcile, not live. An `on` entry has no filter, cooldown or retry; use a routine for those. A manifest that fails to load is logged and skipped. An invalid `on` map is reported as a refusal named `<agent-id>/on`. Any other event name (`turn-end`, for example) is reported under `reactions.refused` as not supported. Only the daemon workspace is scanned.

## Recipe 3: move brain ingest or the clerk onto the durable path

Two builtin reactions are opt-in per workspace, hot, default off. A listed workspace is owned by the reaction and the legacy path skips it, so exactly one path runs each firing.

```json
{ "tool": "config_get", "args": { "keys": ["defaults.reactions.brainIngest.workspaces", "defaults.reactions.clerk.workspaces"] } }
{ "tool": "config_set", "args": { "key": "defaults.reactions.brainIngest.workspaces", "value": ["my-workspace"] } }
```

- `defaults.reactions.brainIngest.workspaces`: completed sessions are ingested into the workspace brain by a reaction (idempotent, replayed after a crash).
- `defaults.reactions.clerk.workspaces`: the clerk controller keeps its gate and its debounce (still in memory, so a restart drops a pending debounce), but the pass itself is dispatched as a receipt with up to 3 attempts. The pass is not idempotent: a pass interrupted by a crash is not replayed.

Rollback: set the key back to `[]` (or `unset: true`). It takes effect on the next completion or firing.

## Reading health: `GET /reactions`

From a daemon terminal (the Bash sandbox cannot reach localhost):

```json
{ "tool": "terminal_start", "args": { "argv": ["curl", "-s", "-H", "Origin: http://localhost:3000", "http://127.0.0.1:18790/reactions"] } }
```

then `terminal_output` with `clean: true`. You get `started`, `maxReactionDepth`, per-binding `counts` (pending, running, done, failed, dead), `latencyMs` (p50, p95, max), `oldestQueuedAgeMs`, `retries`, `deadReasons`, `lastError`, `skipped`, plus `orphans`, `totals` and `wiring` (`active`, `refused`). The daemon also writes one `[reaction-runner] receipt=... status=... attempt=... latencyMs=...` line per attempt. A 404 means the daemon is older than the health route.

## It did not fire: checklist

1. **Is the binding live?** `routine_reconcile`, then read `reactions.refused`. Typical errors: event not supported (only `agentproto:session-completed`), action not registered, duplicate binding id, bad filter.
2. **Did the session really complete?** A killed or errored session without a completed outcome does not emit the event. `session_list` with the outcome fields tells you.
3. **Is the session in scope?** Check the `filter` paths against the session (`isChild`, `workspaceSlug`, `agentId`). An `on` entry never fires for another agent's sessions.
4. **Did a receipt appear?** In `GET /reactions`, the binding's counts. `pending` that never moves means the runner is not started (`started: false`).
5. **Failed or dead?** Read `lastError` and `deadReasons`: `recursion_cap` (reaction chain too deep), `stale_trigger` (the session no longer qualified at boot), `max_attempts`, `non_retryable`.
6. **Skipped by design?** `session:archive` returns `done` with a `skipped:*` outcome for a pinned, `keepAlive`, alive or already archived session.

## Related: retry-safe prompts

A reaction that sends a prompt, or any client that retries `agent_prompt` after a timeout, can pass `dedupeKey` so the prompt is delivered at most once per key inside 24 hours. See `ap-prompt-agent`.

## Pointers

- `ap-cron`: time-based jobs; an event routine is the event-based sibling.
- `ap-lifecycle`: archive, pin and keep-alive, which `session:archive` respects.
- `ap-policies`: completion policies; a passing policy is one way a session counts as completed.
- Design: `docs/design/action-hooks-v1.md` and `docs/design/action-hooks-event-mapping.md` in `agentproto/ts`; the spec is AIP-71.
