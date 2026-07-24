/**
 * Shared disk-read + descriptor-join for the usage-rollup surfaces (the
 * `usage_rollup` MCP tool and the `GET /usage/rollup` REST route). Keeping the
 * collection in ONE place means the two surfaces can't drift on how they
 * enumerate sessions, resolve attribution keys, or tolerate a bad read.
 *
 * This is the impure companion to the pure `usage-rollup.ts` reducer: it
 * touches the registry (which touches disk), where the reducer stays a
 * side-effect-free fold. Surfaces call `collectSessionSnapshots` to build the
 * `SessionSnapshots[]` and hand that straight to `rollupUsage`.
 */
import type { SessionsRegistry } from "./sessions.js"
import type { SessionSnapshots } from "./usage-rollup.js"

/**
 * Read every `agent-cli` session's durable usage snapshots and join them with
 * the attribution keys resolved off the descriptor.
 *
 * - `opts.onlyIds` — when set, keep only descriptors whose `id` is in the set
 *   (subtree scoping for a scoped orchestrator).
 * - `opts.profileRef` — when set, keep only sessions whose resolved
 *   `profileRef` equals it (one-auth-profile filter).
 *
 * Only `kind === "agent-cli"` sessions ever carry usage_snapshots. Archived
 * sessions are included (they still spent money). Sessions with zero snapshots
 * are skipped. A per-session read failure is tolerated — treated as no
 * snapshots (and thus skipped) — so one corrupt transcript can never throw the
 * whole rollup.
 */
export async function collectSessionSnapshots(
  registry: SessionsRegistry,
  opts?: { onlyIds?: Set<string>; profileRef?: string },
): Promise<SessionSnapshots[]> {
  // Archived sessions still spent money → includeArchived. Subtree scoping
  // (onlyIds) is applied against this full list by the caller's collectSubtree.
  let descriptors = registry
    .list({ includeArchived: true })
    .filter(desc => desc.kind === "agent-cli")

  if (opts?.onlyIds) {
    const ids = opts.onlyIds
    descriptors = descriptors.filter(desc => ids.has(desc.id))
  }

  const collected = await Promise.all(
    descriptors.map(async desc => {
      // A per-session read failure must never sink the whole rollup — treat it
      // as "no snapshots" so a single corrupt/half-written transcript is
      // silently skipped below rather than thrown.
      const snapshots = await registry
        .readUsageSnapshots(desc.id)
        .catch(() => [])
      if (snapshots.length === 0) return undefined
      const session: SessionSnapshots = {
        sessionId: desc.id,
        profileRef: desc.accessProfile?.profileRef,
        harness: desc.harness ?? desc.adapterSlug,
        snapshots,
      }
      return session
    }),
  )

  let sessions = collected.filter(
    (s): s is SessionSnapshots => s !== undefined,
  )

  if (opts?.profileRef) {
    const wanted = opts.profileRef
    sessions = sessions.filter(s => s.profileRef === wanted)
  }

  return sessions
}
