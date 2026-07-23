# Routines here have no runtime yet — a bridge proposal (DESIGN ONLY)

`worktree-gc/ROUTINE.md` in this directory is a real, schema-valid AIP-41
routine manifest (`schema: routine/v1`), shipped `enabled: false` since PR
#626. Nothing in this repo turns it into a scheduled fire. This note records
the gap precisely and sketches a bridge — **not built, not decided**; the
call on whether/how to build it belongs to Jeremy.

## The gap, precisely

- `@agentproto/routine` (`packages/routine/src`) parses and validates a
  `ROUTINE.md` — `parseRoutineManifest` → `routineFromManifest` →
  `defineRoutine` (`define-routine.ts`) — into a frozen `RoutineHandle`. That
  handle is **pure data**. `defineRoutine`'s `build()` just spreads the
  validated definition into a new object; there is no `execute()`, no
  scheduling hook, nothing that fires anything.
- Nothing scans a workspace's `.routines/` directory. `grep`ing the whole
  `packages/` tree for a reader of `.routines/*/ROUTINE.md` outside this
  package's own manifest parser and its tests turns up nothing.
- The one LIVE scheduling primitive in the daemon is
  `packages/runtime/src/cron-scheduler.ts`'s `CronScheduler` — persisted,
  ticks every 20s, fires a `CronAction`. Its `CronAction` union
  (`cron-scheduler.ts:50-72`) has exactly three kinds: `command` (spawn a
  shell command), `agent` (spawn a fresh agent session), `prompt-session`
  (reprompt an existing one). **None of them is "call an in-process
  AIP-14 tool by id."**
- AIP-41's own `TargetTool` (`packages/routine/src/types.ts:163-171`) is
  exactly that: `{ tool: string, inputs?: {...} }` — a TOOL ref, not a shell
  command or an agent prompt. There is no `CronAction` shape it maps onto
  today.

That mismatch is why the daily worktree-gc sweep operationalized today as a
`kind:"command"` cron job (`worktree-janitor-daily`) that shells out to
`agentproto worktree gc --apply` — a subprocess, re-spawning a whole CLI
process, re-resolving `git` from scratch — instead of the daemon just
calling its own already-registered `worktree_gc` tool in-process, the way
`worktree_gc` MCP calls do it today. That subprocess indirection is exactly
where Fix A's `spawn git ENOENT` (a narrow inherited PATH baked into the
launchd plist) came from. A `kind:"tool"` bridge doesn't just close the
routine-runtime gap — it removes the entire class of "spawn a CLI to call a
tool the daemon already hosts" bugs for anything wired through it.

## Proposed bridge (not built)

1. **New `CronAction` kind: `"tool"`.**
   ```ts
   | { kind: "tool"; tool: string; inputs?: Record<string, unknown> }
   ```
   Dispatched in-process against the same tool registry the daemon's MCP
   surface already calls `worktree_gc` through — no subprocess, so no PATH
   to get wrong. Whether an argv-prefix-style allowlist (mirroring
   `command-tools.ts`'s `AllowlistEntry`) should gate which tool ids a cron
   job may target is an open question below, not resolved here.

2. **A registrar** — a new module, e.g.
   `packages/runtime/src/routine-cron-bridge.ts` — that:
   - Scans `<workspace>/.routines/*/ROUTINE.md` (the path the existing
     `worktree-gc/ROUTINE.md` doc already documents as the install target).
   - Parses each with `@agentproto/routine`'s existing
     `parseRoutineManifest` / `routineFromManifest` — reuse, not a second
     parser.
   - Keeps only `enabled: true` entries whose `schedule.kind === "cron"`
     (interval/calendar/manual/event schedules are out of scope for a
     *cron*-scheduler bridge by construction; see open questions).
   - Maps `target`: a `TargetTool` becomes `{kind:"tool", tool, inputs}`
     directly. A `TargetAction` or `TargetWorkflow` target has no obvious
     `CronAction` mapping yet — v1 logs "unsupported target kind" and skips
     rather than guessing.
   - Calls `cronScheduler.create(...)`, keyed so a re-scan **upserts**
     rather than accumulates duplicates — needs a stable identifier
     (e.g. a `sourceRoutineId` field added to `CronJob`, or a deterministic
     `label: "routine:<id>"` the registrar diffs against) so editing or
     removing a `ROUTINE.md` is reflected, not just additive.
   - `@agentproto/routine`'s only deps are `gray-matter` + `zod` (checked:
     `packages/routine/package.json`) — light enough that `@agentproto/runtime`
     can depend on it directly, unlike `@agentproto/worktree`, which
     `worktree-gc.ts`'s own docblock deliberately keeps out of the runtime's
     dependency graph as "the heavy dependency."

3. **Trigger points**: run the scan once at daemon boot (`serve.ts`, next to
   where `cron-scheduler.ts` is already constructed), plus a new explicit
   verb (`agentproto routine reload` / a `routines_reload` MCP tool,
   mirroring the existing `cron_list`/`cron_create` surface) so editing a
   `.routines/*.md` doesn't require a daemon restart to take effect.

## Open questions (Jeremy's call, not resolved here)

- **Retry / failure routing.** `CronJob` has no `retry` or `on_failure`
  fields today (`cron-scheduler.ts:74-88`) — a fire either succeeds or
  throws once. AIP-41's `retry.max_attempts` / `on_failure.create_work_item`
  / `fires_events` (AIP-37 vocabulary) have no home on the cron side yet.
  `worktree-gc/ROUTINE.md`'s own `retry.max_attempts: 1` happens to already
  match cron's today-single-attempt behavior, which is why this particular
  routine doesn't surface the gap — a routine that actually wants retries
  or `fires_events` would.
- **Allowlisting `kind:"tool"` cron jobs.** `kind:"command"` gates through
  `.agentproto/allowed-commands.json`. Should an in-process tool call get an
  analogous allowlist, or is "the tool is already registered on this
  daemon" sufficient authorization? Registered tools can mutate a lot
  (`worktree_gc --apply` deletes branches and directories) — this deserves
  its own decision, not a default inherited from the command-allowlist
  model by accident.
- **Where the bridge module lives.** Proposed above as
  `packages/runtime/src/routine-cron-bridge.ts`, but it could equally live
  in the CLI host (next to `makeWorktreeGcRunner`) if the intent is to keep
  `packages/runtime` free of anything that isn't a pure port/injection
  boundary.
- **Non-cron schedules** (`interval`, `calendar`, `manual`, `event`) aren't
  addressed at all — this proposal only closes the `schedule.kind: "cron"`
  case, which is what `worktree-gc/ROUTINE.md` uses.
- **Multi-workspace scope.** v1 above only scans the active workspace's
  `.routines/`, matching how `worktree_status` / `worktree_gc` themselves
  resolve a repo today (`resolveWorktreeQueryRoot` → `getActiveWorkspace`).
