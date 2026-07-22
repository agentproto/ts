/**
 * Activity ledger v1 — the side-effecting PROJECTOR.
 *
 * Sits on the session event bus and keeps the pure projection
 * (`activity-projection.ts`) fresh: on each incoming lifecycle event it
 * re-projects the owner(s) that event can have touched, diffs each record
 * against an in-memory last-projection cache (keyed by the deterministic
 * activity id), and emits `activity:changed` for records whose
 * state/waitingOn actually changed. Because EventRing distributes via
 * `onAny` (`event-ring.ts`), `session_events_poll`, SSE `/events`, and the
 * webhook notifier all carry the new event with no second cursor.
 *
 * **Projection, not a registry** (the repo has ruled twice against
 * registries that mirror derivable state — see `supervisor.ts`'s
 * session→policy note and `worktree/src/status.ts`): `list()` RECOMPUTES
 * from the owners on every call; the cache exists only so the diff knows
 * what it last announced, and deleting it costs nothing but a burst of
 * re-announcements. Deterministic ids make re-projection idempotent.
 *
 * Strictly best-effort: the bus handler and every per-owner projection are
 * wrapped so a throwing owner `list()` can never escape a bus callback.
 * The handler ignores `activity:changed` itself — the projector must never
 * re-enter off its own emissions.
 *
 * Owner inputs are narrow STRUCTURAL slices (the reconciler's
 * `ReconcilerRegistry` pattern): the real `SessionsRegistry`, supervisor,
 * and runners satisfy them, and tests fake them without casts.
 */

import type { SessionEvent, SessionEventBus } from "./session-event-bus.js"
import {
  filterActivities,
  policyToActivities,
  prToActivities,
  routineToActivities,
  turnToActivities,
  workflowToActivities,
  type ActivityListFilter,
  type ActivityPolicySlice,
  type ActivityPrSession,
  type ActivityRecord,
  type ActivityRoutineRunSlice,
  type ActivitySource,
  type ActivityTurnSession,
  type ActivityWaitingOn,
  type ActivityWorkflowRunSlice,
} from "./activity-projection.js"

/** A session as the projector reads it: the turn slice + the PR slice.
 *  The full `SessionDescriptor` satisfies this structurally. */
export interface ActivityProjectorSession extends ActivityTurnSession, ActivityPrSession {}

/** The registry slice the projector needs — structurally satisfied by the
 *  full `SessionsRegistry` (whose no-arg `list()` already excludes archived
 *  sessions, which is exactly the v1 `pr` scoping), and by a trivial fake in
 *  tests. */
export interface ActivityProjectorRegistry {
  list(): readonly ActivityProjectorSession[]
}

/** The supervisor slice — structurally satisfied by
 *  `CompletionPolicySupervisor` (same `list()` that `policy_list` reads). */
export interface ActivityPolicyLister {
  list(): readonly ActivityPolicySlice[]
}

/** The routine-runner slice — structurally satisfied by `RoutineRunner`. */
export interface ActivityRoutineLister {
  list(): readonly ActivityRoutineRunSlice[]
}

/** The workflow-runner slice — structurally satisfied by `WorkflowRunner`. */
export interface ActivityWorkflowLister {
  list(): readonly ActivityWorkflowRunSlice[]
}

export interface ActivityProjector {
  /** Recompute the full projection from the owners and filter it. Never
   *  answered from the cache — this is a projection, not a registry. */
  list(filter?: ActivityListFilter): ActivityRecord[]
  /** Detach the bus subscription and clear the diff cache. */
  dispose(): void
}

// Which projection owner each activity source belongs to — used to scope
// the vanished-record sweep of a per-owner re-projection so one owner's
// diff can never evict another owner's cached rows. `cron` maps to nothing
// (no cron activities in v1).
type ActivityOwner = "session" | "supervisor" | "routine" | "workflow"
const OWNER_OF_SOURCE: Record<ActivitySource, ActivityOwner | undefined> = {
  session: "session",
  "code-host": "session",
  supervisor: "supervisor",
  routine: "routine",
  workflow: "workflow",
  cron: undefined,
}

/** Stable comparison key for a waitingOn — the diff cares about the blocker
 *  identity (kind + refs + detail), not object identity. */
function waitingOnKey(w: ActivityWaitingOn | undefined): string {
  if (!w) return ""
  return `${w.kind}|${w.refs.join(",")}|${w.detail ?? ""}`
}

export function createActivityProjector(opts: {
  registry: ActivityProjectorRegistry
  sessionEvents: SessionEventBus
  supervisor: ActivityPolicyLister
  routineRunner?: ActivityRoutineLister
  workflowRunner?: ActivityWorkflowLister
}): ActivityProjector {
  // Last-announced projection, keyed by deterministic activity id. ONLY for
  // diffing — never the answer to `list()`. Deletable at any time; the cost
  // is a one-off burst of re-announcements, never wrong data.
  const cache = new Map<string, ActivityRecord>()

  const projectOwner = (owner: ActivityOwner): ActivityRecord[] => {
    switch (owner) {
      case "session": {
        // One clock read per projection pass — the mappers themselves stay
        // pure (staleSince is derived from the `now` we hand them).
        const now = new Date().toISOString()
        const out: ActivityRecord[] = []
        for (const session of opts.registry.list()) {
          out.push(...turnToActivities(session, { now }), ...prToActivities(session))
        }
        return out
      }
      case "supervisor":
        return opts.supervisor.list().flatMap(policy => policyToActivities(policy))
      case "routine":
        return opts.routineRunner
          ? opts.routineRunner.list().flatMap(run => routineToActivities(run))
          : []
      case "workflow":
        return opts.workflowRunner
          ? opts.workflowRunner.list().flatMap(run => workflowToActivities(run))
          : []
    }
  }

  /**
   * Re-project one owner and reconcile the cache. `announce: false` is the
   * construction-time prime: pre-existing state (persisted policies, runs
   * reloaded at boot) is cached silently — it isn't a *change*.
   */
  const reprojectOwner = (owner: ActivityOwner, announce: boolean): void => {
    const next = projectOwner(owner)
    const seen = new Set<string>()
    for (const rec of next) {
      seen.add(rec.id)
      const prev = cache.get(rec.id)
      const changed =
        !prev ||
        prev.state !== rec.state ||
        waitingOnKey(prev.waitingOn) !== waitingOnKey(rec.waitingOn)
      // Always keep the freshest snapshot so later diffs compare against
      // what was last projected, even when nothing announcement-worthy moved.
      cache.set(rec.id, rec)
      if (changed && announce) {
        opts.sessionEvents.emit({
          type: "activity:changed",
          activity: rec,
          ts: new Date().toISOString(),
        })
      }
    }
    // Drop THIS owner's vanished ids (e.g. a session removed from the
    // registry). Silent — disappearance is not a state transition, and
    // records normally settle into a terminal state rather than vanish.
    for (const [id, rec] of cache) {
      if (OWNER_OF_SOURCE[rec.source] === owner && !seen.has(id)) cache.delete(id)
    }
  }

  /**
   * Which owners an incoming event can have moved. `policy:*` only moves
   * policy state; `session:*` can move everything (a turn-end flips a
   * watching policy to gating and advances routine/workflow steps WITHOUT
   * any policy/run event of its own); `cron:*` moves nothing in v1; and our
   * own `activity:changed` moves nothing — the re-entrance guard.
   */
  const ownersTouchedBy = (type: SessionEvent["type"]): readonly ActivityOwner[] => {
    if (type === "activity:changed") return []
    if (type.startsWith("policy:")) return ["supervisor"]
    if (type.startsWith("cron:")) return []
    return ["session", "supervisor", "routine", "workflow"]
  }

  const handler = (ev: SessionEvent): void => {
    for (const owner of ownersTouchedBy(ev.type)) {
      // Best-effort per owner: one throwing owner list() must neither escape
      // the bus callback nor starve the remaining owners of their diff.
      try {
        reprojectOwner(owner, true)
      } catch {
        // Swallowed — the next event re-projects from scratch anyway.
      }
    }
  }

  // Prime the cache from current owner state WITHOUT announcing, so a daemon
  // booting over persisted policies/runs doesn't spray `activity:changed`
  // for state nothing changed. Best-effort like every other pass.
  for (const owner of ["session", "supervisor", "routine", "workflow"] as const) {
    try {
      reprojectOwner(owner, false)
    } catch {
      // Swallowed — first event re-projects.
    }
  }

  const unsubscribe = opts.sessionEvents.onAny(handler)

  return {
    list(filter = {}) {
      const all = [
        ...projectOwner("session"),
        ...projectOwner("supervisor"),
        ...projectOwner("routine"),
        ...projectOwner("workflow"),
      ]
      return filterActivities(all, filter)
    },
    dispose() {
      unsubscribe()
      cache.clear()
    },
  }
}
