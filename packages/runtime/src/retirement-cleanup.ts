/**
 * Keeps follows and session-targeted sentinels from pointing at a retired
 * session. On retirement:
 *   - with a successor (`continuedTo`, followed transitively) every follow
 *     whose follower is the retired row, and every sentinel targeting it, is
 *     re-pointed at the successor;
 *   - a FORGOTTEN row (removed from the registry; `DELETE /sessions/:id`, gc
 *     with `forget`) with no successor can never be written to again, so its
 *     follows are deleted and its sentinels cancelled;
 *   - an archived or `killed` row with no successor is left alone HERE:
 *     `kill` emits the retirement event before `retireSession` stamps
 *     `continuedTo`, and archive is reversible. {@link sweepWiringLifecycle}
 *     is the terminal pass that removes such lingering wiring on boot and
 *     periodically, mirroring the cron scheduler's owner lifecycle.
 */

import "./sentinel-platform.js"

import type { SentinelStore } from "@agentproto/sentinel"
import type { SessionFollowStore } from "./session-follow-store.js"
import { isExpiresAtReached } from "./expires-at.js"
import { isRetired, resolveSuccessor } from "./session-retirement.js"
import type { SessionsRegistry } from "./sessions.js"

export interface RetirementCleanupDeps {
  registry: Pick<SessionsRegistry, "get" | "onSessionRetired">
  followStore: SessionFollowStore
  sentinelStore: SentinelStore
  /** Provider-side cancel + record removal (`cancelSentinelWatch`). */
  cancelSentinel: (sentinelId: string) => Promise<unknown>
  log?: (line: string) => void
}

export interface WiringSweepOptions {
  /** Injectable clock (tests). Default `Date.now`. */
  nowMs?: () => number
}

export interface WiringSweepResult {
  followsRemoved: number
  followsRelinked: number
  sentinelsCancelled: number
  sentinelsRelinked: number
}

/**
 * The periodic counterpart to {@link wireRetirementCleanup}: walks every
 * persisted follow/sentinel so wiring whose recipient died before this
 * process started (an orphan from an older daemon) is cleaned up too.
 *
 * Mirrors cron-scheduler's `ownerRetirement`:
 *   - `expiresAt` passed → remove (the bounded backstop);
 *   - recipient row gone → remove;
 *   - recipient retired → relink to a live successor (sentinels: else the
 *     live parent), else remove.
 *
 * Archived rows are included here: unlike the event handler above (which
 * deliberately leaves archive reversible), the sweep is the terminal cleanup
 * pass and runs on boot plus periodically.
 */
export async function sweepWiringLifecycle(
  deps: RetirementCleanupDeps,
  opts: WiringSweepOptions = {},
): Promise<WiringSweepResult> {
  const log = deps.log ?? ((line: string): void => console.warn(line))
  const now = (opts.nowMs ?? Date.now)()
  const result: WiringSweepResult = {
    followsRemoved: 0,
    followsRelinked: 0,
    sentinelsCancelled: 0,
    sentinelsRelinked: 0,
  }

  const liveSuccessor = (id: string): string | undefined => {
    const successor = resolveSuccessor(sid => deps.registry.get(sid), id)
    if (!successor) return undefined
    const desc = deps.registry.get(successor)
    return desc && (desc.status === "running" || desc.status === "starting") ? successor : undefined
  }

  const isLive = (id: string | undefined): id is string => {
    const desc = id ? deps.registry.get(id) : undefined
    return !!desc && !isRetired(desc) && (desc.status === "running" || desc.status === "starting")
  }

  /** Another live sentinel already watches one of `subjects` for `targetId`? */
  const alreadyWatched = (sentinelId: string, targetId: string, subjects: readonly string[]): boolean =>
    deps.sentinelStore
      .list()
      .some(
        s =>
          s.id !== sentinelId &&
          (s.status === "active" || s.status === "orphaned") &&
          s.spec.target.kind === "session" &&
          s.spec.target.sessionId === targetId &&
          s.spec.match.some(m => subjects.includes(m.subject)),
      )

  for (const follow of deps.followStore.list()) {
    const expired = isExpiresAtReached(follow.expiresAt, now)
    if (!expired) {
      const desc = deps.registry.get(follow.follower)
      if (desc && !isRetired(desc)) continue
      const successor = desc ? liveSuccessor(desc.id) : undefined
      if (successor) {
        deps.followStore.setFollower(follow.id, successor)
        result.followsRelinked++
        log(`[retirement-cleanup] follow ${follow.id} re-pointed at ${successor}`)
        continue
      }
    }
    deps.followStore.remove(follow.id)
    result.followsRemoved++
    log(
      `[retirement-cleanup] removed follow ${follow.id} (${expired ? `expired at ${follow.expiresAt}` : `follower ${follow.follower} is gone/retired`})`,
    )
  }

  for (const sentinel of deps.sentinelStore.list()) {
    const target = sentinel.spec.target
    const expired = isExpiresAtReached(sentinel.expiresAt, now)
    if (!expired && target.kind === "session") {
      const desc = deps.registry.get(target.sessionId)
      if (desc && !isRetired(desc)) continue
      // Same rule as the sentinel runtime's dead-session path: successor
      // first, else the live parent; cancel only when neither exists.
      const successor = desc ? (liveSuccessor(desc.id) ?? (isLive(desc.parentSessionId) ? desc.parentSessionId : undefined)) : undefined
      if (successor) {
        // Auto-link gives the parent its own sentinel for this subject; a
        // second watch on the same target would double every notice.
        if (alreadyWatched(sentinel.id, successor, sentinel.spec.match.map(m => m.subject))) {
          await deps.cancelSentinel(sentinel.id).catch(err => {
            log(
              `[retirement-cleanup] failed to cancel duplicate sentinel ${sentinel.id}: ${err instanceof Error ? err.message : String(err)}`,
            )
          })
          result.sentinelsCancelled++
          log(`[retirement-cleanup] cancelled sentinel ${sentinel.id} (duplicate watch for ${successor} already exists)`)
          continue
        }
        deps.sentinelStore.update(sentinel.id, {
          spec: {
            ...sentinel.spec,
            target: { ...target, sessionId: successor },
            ...(sentinel.spec.group !== undefined ? { group: successor } : {}),
          },
        })
        result.sentinelsRelinked++
        log(`[retirement-cleanup] sentinel ${sentinel.id} re-pointed at ${successor}`)
        continue
      }
    } else if (!expired) {
      // Webhook/routine targets have no owning session; only expiry applies.
      continue
    }
    await deps.cancelSentinel(sentinel.id).catch(err => {
      log(
        `[retirement-cleanup] failed to cancel sentinel ${sentinel.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
    result.sentinelsCancelled++
    log(
      `[retirement-cleanup] cancelled sentinel ${sentinel.id} (${expired ? `expired at ${sentinel.expiresAt}` : `target ${target.kind === "session" ? target.sessionId : target.kind} is gone/retired`})`,
    )
  }

  return result
}

export function wireRetirementCleanup(deps: RetirementCleanupDeps): () => void {
  const log = deps.log ?? ((line: string): void => console.warn(line))
  return deps.registry.onSessionRetired(ev => {
    const successor = resolveSuccessor(id => deps.registry.get(id), ev.sessionId) ??
      (ev.continuedTo && deps.registry.get(ev.continuedTo) ? ev.continuedTo : undefined)
    // With no successor only a FORGOTTEN row is hopeless right here: `kill`
    // emits before `retireSession` stamps `continuedTo`, and archive is
    // reversible, so the periodic sweep below is what retires a lingering
    // archived/stopped row's wiring.
    const hopeless = !successor && ev.cause === "forgotten"
    if (!successor && !hopeless) return
    for (const follow of deps.followStore.list({ follower: ev.sessionId })) {
      if (successor) deps.followStore.setFollower(follow.id, successor)
      else deps.followStore.remove(follow.id)
    }
    for (const sentinel of deps.sentinelStore.list()) {
      const target = sentinel.spec.target
      if (target.kind !== "session" || target.sessionId !== ev.sessionId) continue
      if (successor) {
        deps.sentinelStore.update(sentinel.id, {
          spec: { ...sentinel.spec, target: { ...target, sessionId: successor } },
        })
      } else {
        void deps.cancelSentinel(sentinel.id).catch(err => {
          log(`[retirement-cleanup] failed to cancel sentinel ${sentinel.id}: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
    }
  })
}
