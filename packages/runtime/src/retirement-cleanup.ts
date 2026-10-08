/**
 * Keeps follows and session-targeted sentinels from pointing at a retired
 * session. On retirement:
 *   - with a successor (`continuedTo`, followed transitively) every follow
 *     whose follower is the retired row, and every sentinel targeting it, is
 *     re-pointed at the successor;
 *   - a FORGOTTEN row (removed from the registry; `DELETE /sessions/:id`, gc
 *     with `forget`) with no successor can never be written to again, so its
 *     follows are deleted and its sentinels cancelled;
 *   - an archived or `killed` row with no successor is left alone: archive is
 *     reversible (unarchive) and a client may be about to migrate the wiring
 *     to a replacement (`POST /sessions/:id/retire`). Delivery to it parks
 *     instead of reviving it — see `session-follow.ts` / `sentinel-runtime.ts`.
 *     (Operator-stopped rows with no successor therefore keep their sentinels
 *     until the row is forgotten.)
 */

import type { SentinelStore } from "./sentinel-store.js"
import type { SessionFollowStore } from "./session-follow-store.js"
import { resolveSuccessor } from "./session-retirement.js"
import type { SessionsRegistry } from "./sessions.js"

export interface RetirementCleanupDeps {
  registry: Pick<SessionsRegistry, "get" | "onSessionRetired">
  followStore: SessionFollowStore
  sentinelStore: SentinelStore
  /** Provider-side cancel + record removal (`cancelSentinelWatch`). */
  cancelSentinel: (sentinelId: string) => Promise<unknown>
  log?: (line: string) => void
}

export function wireRetirementCleanup(deps: RetirementCleanupDeps): () => void {
  const log = deps.log ?? ((line: string): void => console.warn(line))
  return deps.registry.onSessionRetired(ev => {
    const successor = resolveSuccessor(id => deps.registry.get(id), ev.sessionId) ??
      (ev.continuedTo && deps.registry.get(ev.continuedTo) ? ev.continuedTo : undefined)
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
