/**
 * Bounded eager resume-on-boot pass (session-survivability plan §5, PR-4).
 *
 * Lazy resume-on-prompt (`maybeResumeAgent`, triggered by the first
 * `sendPrompt`/`enqueuePrompt` on a dead row) is always on — it costs nothing
 * until someone acts. This pass is the OPT-IN eager half: after a daemon
 * restart, walk the rehydrated ghosts and re-spawn the eager-eligible ones IN
 * PLACE, without waiting for a prompt, so orchestrated fleets and completion
 * policies find their sessions live again rather than dead-but-lazy-resumable.
 *
 * The per-row work — eligibility, auth re-resolution, the `session:resumed`
 * event + interrupted banner, the attempt cap, and the no-fresh-spawn rule —
 * all lives behind the registry's `resumeOnBoot(id)`. This module owns only the
 * ORCHESTRATION the plan pins to the boot pass:
 *   - candidate selection (`canResume` ∧ `endedReason === "daemon-restart"`,
 *     minus rows this daemon doesn't serve — the cross-process gate);
 *   - ordering by `lastActivityAt` desc so the most relevant sessions come back
 *     first (§5 "Resume-storm control");
 *   - a small concurrency cap so a box-wide restart doesn't spawn N adapters at
 *     once (§5 "Resume-storm control");
 *   - a summary the caller turns into the boot-banner line.
 *
 * MUST run AFTER the supervisor is re-armed (§5 "Event ordering vs the
 * supervisor"): this pass emits `session:resumed`, never a second
 * `session:exited`, so a re-armed lone-session completion policy survives the
 * restart instead of being cancelled. The caller enforces the ordering by
 * invoking this only once the gateway (and its supervisor) is fully built.
 */

import {
  canResume,
  type EagerResumeOutcome,
  type SessionDescriptor,
  type SessionsRegistry,
} from "./sessions.js"

/** Tally of one eager resume-on-boot pass, for the boot-banner summary line. */
export interface EagerResumeSummary {
  /** Whether the pass actually ran. False when the daemon config knob
   *  (`daemon.resumeSessionsOnBoot`) is off — the pass short-circuits and
   *  every count is 0. Lets a caller distinguish "ran, found nothing" from
   *  "never ran". */
  enabled: boolean
  /** Rows that matched eager-eligibility — the denominator of the
   *  "eager-resumed N/M sessions" banner line. */
  candidates: number
  /** Rows brought back to `running` (`resumeOnBoot` → `resumed`). */
  resumed: number
  /** Rows attempted but not resumed — adapter refused the id (left
   *  dead-but-lazy-resumable, never fresh-spawned) or the worktree was gone. */
  failed: number
  /** Rows that never reached the adapter — already live (a lazy prompt raced
   *  this pass), cap-exhausted, or a worktree-generation mismatch. */
  skipped: number
}

/** Newest-activity-first ordering for the candidate list: the sessions most
 *  likely to matter come back first under the concurrency cap. Falls back to
 *  `startedAt` when a row never recorded activity (both are ISO-8601, so a
 *  lexical compare is chronological). */
function byLastActivityDesc(a: SessionDescriptor, b: SessionDescriptor): number {
  const at = a.lastActivityAt ?? a.startedAt
  const bt = b.lastActivityAt ?? b.startedAt
  return bt.localeCompare(at)
}

/**
 * Run the bounded eager resume-on-boot pass. See the module docblock for the
 * ordering contract. Returns the tally; the caller (serve.ts) prints the banner
 * line and does not otherwise act on it.
 */
export async function runEagerResumePass(opts: {
  /** The gateway's sessions registry (already rehydrated from disk at boot). */
  registry: Pick<SessionsRegistry, "list" | "resumeOnBoot">
  /** Max adapters spawned concurrently (§5 "Resume-storm control"). Clamped to
   *  at least 1 — a non-positive cap would resume nothing. */
  concurrency: number
  /** Cross-process gate (§5): with two daemons sharing the workspace buckets,
   *  each must only resume rows for the workspace IT serves. Return false to
   *  exclude a row from THIS daemon's pass. Omitted ⇒ every eligible row is
   *  served (the single-daemon common case + tests). */
  isServed?: (desc: SessionDescriptor) => boolean
}): Promise<EagerResumeSummary> {
  const { registry, isServed } = opts
  const limit = Math.max(1, Math.floor(opts.concurrency))

  // Candidate selection. `canResume` folds in `isResumable` + the attempt cap;
  // the `daemon-restart` clause is the eager-only gate; `isServed` is the
  // cross-process gate. `list()` already excludes archived rows. `resumeOnBoot`
  // re-checks every one of these authoritatively per row — this filter only
  // bounds the work and fixes the denominator.
  const candidates = registry
    .list()
    .filter(
      d =>
        canResume(d) &&
        d.endedReason === "daemon-restart" &&
        (isServed?.(d) ?? true),
    )
    .sort(byLastActivityDesc)

  const summary: EagerResumeSummary = {
    enabled: true,
    candidates: candidates.length,
    resumed: 0,
    failed: 0,
    skipped: 0,
  }
  if (candidates.length === 0) return summary

  const tally = (outcome: EagerResumeOutcome): void => {
    if (outcome.status === "resumed") summary.resumed++
    else if (outcome.status === "failed") summary.failed++
    else summary.skipped++
  }

  // Index-based worker pool: at most `limit` `resumeOnBoot` calls in flight at
  // once, the rest queue until a slot frees. A per-row failure never rejects
  // the pass — `resumeOnBoot` is no-throw by contract, but guard anyway so one
  // unexpected throw can't abort the whole boot pass and leave later candidates
  // untried.
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < candidates.length) {
      const desc = candidates[cursor++]!
      try {
        tally(await registry.resumeOnBoot(desc.id))
      } catch {
        summary.failed++
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, candidates.length) }, () => worker()),
  )
  return summary
}
