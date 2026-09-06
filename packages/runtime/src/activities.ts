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
 *
 * The one ASYNC enrichment — PR settlement — stays outside the projection:
 * the injected {@link PrStateResolver} port (CLI-wired, the `OpenPrResolver`
 * pattern) fills a memoized url→state map at `session:exited` and on a
 * bounded periodic sweep, and the pure pr mapper merely READS that map, so
 * `list()` never awaits and the runtime never touches a forge.
 */

import type { SessionEvent, SessionEventBus } from "./session-event-bus.js"
import {
  filterActivities,
  isTerminalActivityState,
  linkTasks,
  policyToActivities,
  prToActivities,
  turnToActivities,
  workflowToActivities,
  type ActivityListFilter,
  type ActivityPolicySlice,
  type ActivityPrSession,
  type ActivityRecord,
  type ActivitySource,
  type ActivityTaskSlice,
  type ActivityTurnSession,
  type ActivityWaitingOn,
  type ActivityWorkflowRunSlice,
  type PrResolvedState,
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

/** The workflow-runner slice — structurally satisfied by `WorkflowRunner`. */
export interface ActivityWorkflowLister {
  list(): readonly ActivityWorkflowRunSlice[]
}

/** The task-ledger slice — structurally satisfied by `TaskLedger` (whose
 *  `snapshot()` returns every task, all boards; the scoped `list()` would
 *  hide boards the join must see). Enriches `turn`/`policy` activities with
 *  `taskId` at read time. */
export interface ActivityTaskLister {
  snapshot(): readonly ActivityTaskSlice[]
}

/**
 * Resolve a PR url's current forge state — `null` when it could not be
 * resolved (no `gh`, unreachable forge, non-GitHub url; never a throw the
 * projector has to guard beyond a catch). Injected by the CLI host because
 * forge access runs over `@agentproto/worktree`, a dependency the runtime
 * deliberately does not take (the {@link OpenPrResolver} pattern). Omitted →
 * `pr` activities stay pending on the forge forever (the v1 behaviour).
 */
export type PrStateResolver = (prUrl: string) => Promise<PrResolvedState | null>

export interface ActivityProjector {
  /** Recompute the full projection from the owners and filter it. Never
   *  answered from the cache — this is a projection, not a registry. */
  list(filter?: ActivityListFilter): ActivityRecord[]
  /**
   * Block until the activity with `id` next announces a change
   * (`activity:changed` — its state/waitingOn actually moved), resolving
   * with the freshly-projected record. Resolves IMMEDIATELY when the id is
   * already terminal (terminal records are immutable — nothing further will
   * ever announce), and with `null` when `timeoutMs` (default 25s) elapses
   * with no change. An id that doesn't exist yet is a legitimate wait — the
   * record may appear (and announce) during the window; callers wanting a
   * fast 404 check `list({includeTerminal:true})` themselves (the
   * `GET /activities/:id/wait` route does).
   */
  wait(id: string, opts?: { timeoutMs?: number }): Promise<ActivityRecord | null>
  /** Detach the bus subscription + refresh timer and clear the caches. */
  dispose(): void
}

// Which projection owner each activity source belongs to — used to scope
// the vanished-record sweep of a per-owner re-projection so one owner's
// diff can never evict another owner's cached rows. `cron` maps to nothing
// (no cron activities in v1).
type ActivityOwner = "session" | "supervisor" | "workflow"
const OWNER_OF_SOURCE: Record<ActivitySource, ActivityOwner | undefined> = {
  session: "session",
  "code-host": "session",
  supervisor: "supervisor",
  workflow: "workflow",
  cron: undefined,
}

/** Stable comparison key for a waitingOn — the diff cares about the blocker
 *  identity (kind + refs + detail), not object identity. */
function waitingOnKey(w: ActivityWaitingOn | undefined): string {
  if (!w) return ""
  return `${w.kind}|${w.refs.join(",")}|${w.detail ?? ""}`
}

/** How often the bounded periodic PR-settlement sweep re-asks the forge
 *  about still-open PR urls. Deliberately lazy — a PR usually merges well
 *  after its session exited, so the sweep (not the exit checkpoint) is what
 *  eventually settles it, and 5 minutes of latency on a read-model flag is
 *  fine. */
export const PR_SETTLE_SWEEP_INTERVAL_MS = 5 * 60_000
/** Cap on forge round-trips per sweep, so a registry full of open PRs can
 *  never turn the timer into a forge hammer. Unresolved urls just wait for
 *  the next sweep. */
const PR_SETTLE_SWEEP_MAX_URLS = 10

export function createActivityProjector(opts: {
  registry: ActivityProjectorRegistry
  sessionEvents: SessionEventBus
  supervisor: ActivityPolicyLister
  workflowRunner?: ActivityWorkflowLister
  taskLedger?: ActivityTaskLister
  /** Optional forge port for PR settlement — see {@link PrStateResolver}. */
  resolvePrState?: PrStateResolver
}): ActivityProjector {
  // Last-announced projection, keyed by deterministic activity id. ONLY for
  // diffing — never the answer to `list()`. Deletable at any time; the cost
  // is a one-off burst of re-announcements, never wrong data.
  const cache = new Map<string, ActivityRecord>()

  // Memoized forge verdicts per PR url, read by the (pure) pr mapper via a
  // lookup. `merged`/`closed` are immutable so they are never re-resolved;
  // `open` is re-checked by later passes. Unlike the diff cache this one is
  // NOT freely deletable state derived from the owners — it is the projector's
  // own enrichment — but losing it only regresses records to pending-on-forge
  // until the next settlement pass, never to wrong data.
  const prStates = new Map<string, PrResolvedState>()

  const projectOwnerRaw = (owner: ActivityOwner): ActivityRecord[] => {
    switch (owner) {
      case "session": {
        // One clock read per projection pass — the mappers themselves stay
        // pure (staleSince is derived from the `now` we hand them, settled
        // PR states from the `resolvedPrState` lookup).
        const now = new Date().toISOString()
        const out: ActivityRecord[] = []
        for (const session of opts.registry.list()) {
          out.push(
            ...turnToActivities(session, { now }),
            ...prToActivities(session, { resolvedPrState: url => prStates.get(url) }),
          )
        }
        return out
      }
      case "supervisor":
        return opts.supervisor.list().flatMap(policy => policyToActivities(policy))
      case "workflow":
        return opts.workflowRunner
          ? opts.workflowRunner.list().flatMap(run => workflowToActivities(run))
          : []
    }
  }

  // Enrich `turn`/`policy` records with the Task they advance — a read-time
  // join over the ledger's edges, applied only to the two owners whose kinds
  // can link (a session's turn, a policy's verify gate). No ledger → no join.
  const projectOwner = (owner: ActivityOwner): ActivityRecord[] => {
    const recs = projectOwnerRaw(owner)
    return opts.taskLedger && (owner === "session" || owner === "supervisor")
      ? linkTasks(recs, opts.taskLedger.snapshot())
      : recs
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
        prev.taskId !== rec.taskId ||
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
   * watching policy to gating and advances workflow steps WITHOUT any
   * policy/run event of its own); `cron:*` moves nothing in v1; and our own
   * `activity:changed` moves nothing — the re-entrance guard.
   */
  const ownersTouchedBy = (type: SessionEvent["type"]): readonly ActivityOwner[] => {
    if (type === "activity:changed") return []
    // A task claim/close moves no owner's *state*, but it can change the
    // `taskId` join on turn + policy activities — re-project those two.
    if (type === "task:changed") return ["session", "supervisor"]
    if (type.startsWith("policy:")) return ["supervisor"]
    if (type.startsWith("cron:")) return []
    return ["session", "supervisor", "workflow"]
  }

  // ── PR settlement (the injected forge port) ────────────────────────
  // A pr activity is pending-on-forge until the forge says merged/closed.
  // Resolution is ASYNC (a real forge round-trip), so it can't live inside
  // the synchronous projection — instead these passes update `prStates` and
  // re-project the session owner, whose diff announces any pr record that
  // just settled (pending → done/cancelled). Two triggers, both best-effort:
  // `session:exited` (the natural checkpoint for that session's PRs) and a
  // bounded periodic sweep (a PR usually merges AFTER its session exited,
  // so exit-time alone would almost never observe the settlement).

  /** Un-settled PR urls currently projected — at most `max`, deduped. */
  const unsettledPrUrls = (sessions: readonly ActivityProjectorSession[], max: number): string[] => {
    const urls: string[] = []
    const seen = new Set<string>()
    for (const session of sessions) {
      for (const pr of session.openedPrs ?? []) {
        const known = prStates.get(pr.url)
        if (known === "merged" || known === "closed") continue
        if (seen.has(pr.url)) continue
        seen.add(pr.url)
        urls.push(pr.url)
        if (urls.length >= max) return urls
      }
    }
    return urls
  }

  /** Resolve each url through the port, update the memo, and re-project the
   *  session owner (announcing) when any verdict actually moved. */
  const settleUrls = async (urls: readonly string[]): Promise<void> => {
    const resolvePrState = opts.resolvePrState
    if (!resolvePrState || urls.length === 0) return
    let moved = false
    for (const url of urls) {
      const state = await resolvePrState(url).catch((): null => null)
      if (state === null || prStates.get(url) === state) continue
      prStates.set(url, state)
      moved = true
    }
    if (moved) reprojectOwner("session", true)
  }

  const settleSessionPrs = (sessionId: string): void => {
    if (!opts.resolvePrState) return
    const session = opts.registry.list().find(s => s.id === sessionId)
    if (!session) return
    // Fire-and-forget: a settlement error must never escape the bus callback
    // (the reconciler's `safeReconcile` idiom).
    void settleUrls(unsettledPrUrls([session], PR_SETTLE_SWEEP_MAX_URLS)).catch(() => {})
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
    // The async settlement checkpoint rides AFTER the synchronous diff so it
    // observes (and can later flip) the freshly-cached pending pr records.
    if (ev.type === "session:exited") {
      try {
        settleSessionPrs(ev.sessionId)
      } catch {
        // Swallowed — the periodic sweep retries.
      }
    }
  }

  // Prime the cache from current owner state WITHOUT announcing, so a daemon
  // booting over persisted policies/runs doesn't spray `activity:changed`
  // for state nothing changed. Best-effort like every other pass.
  for (const owner of ["session", "supervisor", "workflow"] as const) {
    try {
      reprojectOwner(owner, false)
    } catch {
      // Swallowed — first event re-projects.
    }
  }

  const unsubscribe = opts.sessionEvents.onAny(handler)

  // The bounded periodic sweep — only armed when the port is wired, and
  // `unref`ed so an idle daemon can still exit. Each tick is one bounded
  // batch of forge round-trips; anything left over waits for the next tick.
  const sweepTimer = opts.resolvePrState
    ? setInterval(() => {
        try {
          void settleUrls(
            unsettledPrUrls(opts.registry.list(), PR_SETTLE_SWEEP_MAX_URLS),
          ).catch(() => {})
        } catch {
          // Swallowed — a throwing registry list() must not kill the timer.
        }
      }, PR_SETTLE_SWEEP_INTERVAL_MS)
    : undefined
  sweepTimer?.unref()

  const list = (filter: ActivityListFilter = {}): ActivityRecord[] => {
    // Best-effort per owner, mirroring the bus handler: one malformed owner
    // (e.g. a persisted slice the mapper can't digest) is warned about and
    // SKIPPED — it must never throw out of `list()` and take the whole
    // read-model down with it.
    const all: ActivityRecord[] = []
    for (const owner of ["session", "supervisor", "workflow"] as const) {
      try {
        all.push(...projectOwner(owner))
      } catch (err) {
        console.warn(`[activities] owner "${owner}" projection failed; skipping its records`, err)
      }
    }
    return filterActivities(all, filter)
  }

  return {
    list,
    wait(id, waitOpts = {}) {
      const { timeoutMs = 25_000 } = waitOpts
      // Fast path: already terminal — immutable, nothing will ever announce
      // again, so blocking would only ride out the timeout for no answer.
      const current = list({ includeTerminal: true }).find(rec => rec.id === id)
      if (current && isTerminalActivityState(current.state)) {
        return Promise.resolve(current)
      }
      // Otherwise resolve on the first `activity:changed` for this id (the
      // projector's own diff is the single announcer, so "changed" here means
      // state/waitingOn really moved) — or null on timeout. Same
      // subscribe-then-race shape as `monitorPolicyWait`.
      return new Promise(resolve => {
        let settled = false
        const finish = (value: ActivityRecord | null): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          unsubscribeWait()
          resolve(value)
        }
        const timer = setTimeout(() => finish(null), timeoutMs)
        const unsubscribeWait = opts.sessionEvents.on("activity:changed", ev => {
          if (ev.activity.id === id) finish(ev.activity)
        })
      })
    },
    dispose() {
      unsubscribe()
      if (sweepTimer) clearInterval(sweepTimer)
      cache.clear()
      prStates.clear()
    },
  }
}
