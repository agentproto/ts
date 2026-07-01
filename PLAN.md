# agentproto — durable cron scheduler (daemon-native, survives restarts)

## Context

Orchestrating agentproto sessions from a coding assistant surfaced two gaps:
(1) no scriptable wait primitive (being fixed separately, in the sibling
worktree `_agentproto-worktrees/session-wait-cli`, branch
`feat/session-wait-cli` — DO NOT touch those files, no overlap expected but
be aware it exists), and (2) **no recurring scheduler** — nothing equivalent
to a crontab or to Claude Code's own `CronCreate`/`CronList`/`CronDelete`
(schedule a command or an agent prompt to fire on an interval, recurring or
one-shot, surviving a daemon restart). `run-swarm --interval` is
swarm-specific (bespoke `setInterval`, not persisted, not general-purpose).
The existing `RoutineRunner` (merged, live, persisted to
`~/.agentproto/routine-runs.json`) is a **finite** multi-step sequence with
fan-in — verified it has no schedule/recurrence field, so it cannot express
"run this every 30 minutes forever."

Goal: a `CronScheduler` daemon singleton — persisted, survives restarts,
fires shell-command or agent-spawn jobs on a real cron schedule — exposed via
REST (for the CLI) and MCP (for agent/orchestrator clients), following the
exact conventions already established in this codebase for `RoutineRunner`.

## Grounded findings (verified against `main` @ 8d1191e)

- **Daemon boot** (`packages/runtime/src/index.ts:261-425`): event
  infrastructure → `createSessionsRegistry()` (:348) → orchestration
  singletons — `createCompletionPolicySupervisor()` (:392),
  `createRoutineRunner()` (:417-425, `persist:true`) — → HTTP server starts
  later (~:540+). A new `createCronScheduler()` singleton belongs right after
  `createRoutineRunner()`, gets the same `sessions` registry + `sessionEvents`
  bus + adapter-resolution callback RoutineRunner already receives.
- **Persistence convention** (uniform across `routine-runs.json`,
  `policies.json`, tunnel registry): atomic write — `writeFileSync` to
  `${path}.tmp.${pid}` then `renameSync()` — malformed JSON on load is
  silently skipped (resume empty), in-flight entries get marked `failed`/
  stale on boot recovery. `cron-jobs.json` follows the identical pattern.
  Reference: `packages/runtime/src/routine-runner.ts:132-189` (load/save).
- **MCP naming convention** ("family-first taxonomy", commit `8d1191e`):
  `packages/runtime/src/orchestrator-gateway.ts:59-72` — `agent_*`,
  `session_*`, `policy_*`, `routine_*`. New tools: `cron_create`,
  `cron_list`, `cron_delete`, `cron_run` (manual fire, for testing/debugging).
- **CLI verb dispatch**: `packages/cli/src/cli.ts` — VERBS set (:101-120) +
  switch (:146-193), e.g. `case "sessions": return runSessions(rest)`
  (:179). Add `"cron"` to VERBS, `case "cron": return runCron(rest)`, new
  file `packages/cli/src/commands/cron.ts` following the multi-verb shape of
  `sessions.ts`/`workspace.ts`.
- **CLI↔daemon transport**: plain HTTP REST via `discoverDaemon()` +
  `httpGetJson()`/`httpPostJson()` (`_daemon-helpers.ts`) — NOT MCP JSON-RPC
  from the CLI process. Cron CRUD needs REST endpoints in the http-server,
  mirroring the `/sessions/*` route shape, calling into the same
  `CronScheduler` service the MCP tools call (one implementation, two thin
  surfaces).
- **No cron-expression parser exists** in the monorepo (checked root +
  package.json's, no `croner`/`node-cron`/`node-schedule`). `parseInterval()`
  (`run-swarm.ts:248-255`) only does simple `Ns`/`Nms` durations, not
  schedule expressions, and is swarm-specific/unshared (heartbeat.ts
  duplicates its own `parseDuration()` rather than importing it).

## Decision: adopt `croner` for schedule parsing

Standard 5-field cron in local time, same mental model as Claude Code's own
`CronCreate`. Hand-rolling cron math (DST, month boundaries, day-of-week) is
a well-known bug source. `croner` is small, zero-dependency, TypeScript-
native, no native bindings (safe for a daemon package). Add it as a
dependency of `packages/runtime`.

## What to build

### 1. `packages/runtime/src/cron-scheduler.ts` — the singleton

- Job schema: `{ id, label, schedule: string /* 5-field cron */, recurring:
  boolean, action: { kind: "command", command, args?, cwd?, timeoutMs? } |
  { kind: "agent", adapter, prompt, cwd?, model? }, createdAt, active,
  nextRunAt, lastRunAt?, lastResult?: { ok: boolean, summary: string } }`.
- **One internal tick loop** (not one `setInterval` per job — avoids timer
  leaks/drift as jobs accumulate): a single interval (~15-30s) that scans all
  active jobs, fires any whose `nextRunAt` has passed, recomputes
  `nextRunAt` via `croner`, and deactivates one-shot jobs after firing
  (mirrors Claude Code's own one-shot semantics).
- `command` jobs MUST go through the SAME allowlist enforcement
  `execute_command`/the policy gate already use (`<workspace>/.agentproto/
  allowed-commands.json`, default-deny) — do not add a second, looser
  execution path. Find and reuse that check point rather than
  reimplementing it.
- `agent` jobs reuse the sessions registry's existing spawn capability (same
  one `agent_start`/RoutineRunner use) — spawn (or resume, if the job
  references a persistent label) + prompt, fire-and-forget from the
  scheduler's perspective (result recorded async on turn-end).
- On each fire, emit an event on the existing `SessionEventBus`/`EventRing`
  (new types `cron:fired`, `cron:succeeded`, `cron:failed`) so job outcomes
  are observable through the SAME `session_monitor`/`session_events_poll`
  machinery already in place — no parallel/siloed notification path.
- Persistence: `~/.agentproto/cron-jobs.json`, atomic write-tmp+rename,
  loaded at boot; jobs stay defined across restarts (unlike RoutineRunner
  runs, cron job DEFINITIONS aren't "in-flight state" to fail on boot — only
  `nextRunAt` needs recomputing if the daemon was down past a fire time:
  recurring jobs just resume from "now"; skipped fires during downtime are
  NOT backfilled, document this explicitly).

### 2. MCP tools — `packages/runtime/src/orchestration-tools.ts`

`cron_create` (schedule, recurring, action → returns job id), `cron_list`,
`cron_delete(id)`, `cron_run(id)` (manual fire, bypasses schedule, for
testing). Registered in `registerOrchestrationTools()` gated on
`if (cronScheduler)`, matching the `routineRunner` conditional pattern.
**Deliberately NOT added to `DEFAULT_ORCHESTRATOR_TOOLS`** (child
orchestrators don't get cron-install privilege by default — this installs
persistent host-level recurring jobs, a materially bigger privilege than
session/policy tools already in that default set; make it opt-in via
explicit `orchestrator.tools` allowlist only).

### 3. REST endpoints — http-server

`POST /cron` (create), `GET /cron` (list), `DELETE /cron/:id`,
`POST /cron/:id/run` (manual fire) — same route shape as the existing
`/sessions/*` family, calling the same `CronScheduler` methods the MCP tools
call.

### 4. CLI — `packages/cli/src/commands/cron.ts`

`agentproto cron add --schedule "<5-field cron>" [--command <cmd> --args
<...> | --adapter <slug> --prompt <text>] [--label <text>] [--once]`,
`agentproto cron list [--json]`, `agentproto cron remove <id>`,
`agentproto cron run <id>` (manual fire). Wire into `cli.ts`'s VERBS set +
switch, add usage examples to the USAGE string.

## Explicitly out of scope for v1

- Timezone handling beyond the daemon host's system-local time (no per-job
  timezone override).
- Retry-on-failure policy for cron job actions (record `lastResult`, no
  auto-retry loop — that's a different concept from `policy_attach`'s
  turn-end gate retries).
- Backfilling missed fires across a daemon-down window (documented behavior:
  skipped, not queued).
- Chaining a cron job into a `RoutineRunner` multi-step run (future
  composition, not required for v1).
- A dashboard/TUI for cron jobs beyond CLI `--json`/MCP tool output.

## Verification (required, not optional)

1. Add `croner` to `packages/runtime/package.json`, `pnpm install`.
2. Build `packages/runtime` + `packages/cli`, `pnpm check-types`, fix
   anything broken.
3. Live-test against a running local daemon if one is reachable in this
   environment: `agentproto cron add --schedule "* * * * *" --command echo
   --args hello --once` (fires within 60s), poll `agentproto cron list
   --json` to see `lastResult`, confirm the one-shot job deactivates after
   firing. Test a recurring job fires more than once. Restart the daemon
   mid-test, confirm the job definition survives (`cron-jobs.json`
   round-trips) and resumes scheduling. If no live daemon is reachable, say
   so explicitly rather than skipping verification silently.
4. Confirm a `command` job targeting a non-allowlisted binary is rejected
   the same way `execute_command` rejects it (shared enforcement, not a
   bypass).

## Critical files

- `packages/runtime/src/cron-scheduler.ts` (new) — the singleton, modeled on
  `packages/runtime/src/routine-runner.ts`'s persistence shape.
- `packages/runtime/src/index.ts` (~:425) — singleton construction at boot.
- `packages/runtime/src/orchestration-tools.ts` — `cron_*` MCP tools.
- `packages/runtime/src/orchestrator-gateway.ts` — confirm `cron_*` is
  excluded from `DEFAULT_ORCHESTRATOR_TOOLS`.
- `packages/runtime/src/http-server.ts` — `/cron*` REST routes.
- `packages/cli/src/commands/cron.ts` (new), `packages/cli/src/cli.ts` —
  VERBS + dispatch.
- `~/.agentproto/cron-jobs.json` — new persisted state file, same family as
  `routine-runs.json`/`policies.json`.

## Report back

Every file created/modified (one line each), check-types/build output, and
an honest account of what was and wasn't verified live. If the actual event
bus / policy engine internals don't match this plan's assumptions, stop and
report the discrepancy rather than improvising around it.
