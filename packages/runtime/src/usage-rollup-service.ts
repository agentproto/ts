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
import { listAuthProfiles, type AuthProfile } from "@agentproto/auth"
import type { SessionsRegistry } from "./sessions.js"
import type { SessionSnapshots, UsageRollup } from "./usage-rollup.js"
import {
  AnthropicRemainingQuotaReader,
  type QuotaReadableProfile,
  type RemainingQuota,
  type RemainingQuotaReader,
} from "./remaining-quota.js"

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

/** Overall wall-clock cap on the whole enrichment fan-out — a floor over the
 *  reader's own per-call timeout so one wedged provider can't stall the
 *  rollup. Well beyond a single ~2500ms reader probe, but still short. */
const DEFAULT_ENRICH_CAP_MS = 5_000

/**
 * Best-effort enrich a rollup's `byProfile` entries with each profile's live
 * provider remaining quota. Pure over its inputs (returns a NEW rollup, never
 * mutates), and non-fatal by construction:
 *
 *  - `"unknown"`/empty profileRefs are skipped (no real profile to query).
 *  - an unresolvable profile is skipped.
 *  - each `reader.readRemainingQuota` runs under `Promise.allSettled`, so one
 *    rejection attaches no `remaining` and leaves every other entry intact.
 *  - the whole fan-out is capped by `timeoutMs`; if the cap fires first the
 *    ORIGINAL (un-enriched) rollup is returned.
 */
export async function enrichWithRemainingQuota(
  rollup: UsageRollup,
  opts: {
    reader: RemainingQuotaReader
    resolveProfile: (profileRef: string) => QuotaReadableProfile | undefined
    window: string
    timeoutMs?: number
  },
): Promise<UsageRollup> {
  const targets = rollup.byProfile
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.profileRef !== "unknown" && entry.profileRef.length > 0)

  if (targets.length === 0) return rollup

  const work = Promise.allSettled(
    targets.map(async ({ entry, index }) => {
      const profile = opts.resolveProfile(entry.profileRef)
      const remaining = profile
        ? await opts.reader.readRemainingQuota(profile, opts.window)
        : undefined
      return { index, remaining }
    }),
  )

  const capMs = opts.timeoutMs ?? DEFAULT_ENRICH_CAP_MS
  const cap = new Promise<null>(resolve => {
    setTimeout(() => resolve(null), capMs)
  })
  const settled = await Promise.race([work, cap])
  if (settled === null) return rollup // overall cap fired → leave rollup as-is

  const remainingByIndex = new Map<number, RemainingQuota>()
  for (const result of settled) {
    if (result.status === "fulfilled" && result.value.remaining) {
      remainingByIndex.set(result.value.index, result.value.remaining)
    }
  }
  if (remainingByIndex.size === 0) return rollup

  return {
    ...rollup,
    byProfile: rollup.byProfile.map((entry, index) => {
      const remaining = remainingByIndex.get(index)
      return remaining ? { ...entry, remaining } : entry
    }),
  }
}

/** Project a stored `AuthProfile` down to the minimal shape a quota reader
 *  needs. */
function toQuotaReadableProfile(profile: AuthProfile): QuotaReadableProfile {
  return {
    profileRef: profile.id,
    endpoint: profile.endpoint,
    method: profile.method,
    ...(profile.source ? { source: profile.source } : {}),
  }
}

/**
 * Surface-shared, fully non-fatal wrapper both the `usage_rollup` MCP tool and
 * `GET /usage/rollup` call after `rollupUsage`. Instantiates the default
 * (real-fetch) Anthropic reader, resolves the auth profiles once, and enriches
 * — but if ANYTHING throws (profile load, reader construction, enrichment) it
 * returns the original rollup untouched. The rollup NEVER depends on this
 * succeeding.
 *
 * `deps` is injectable purely for tests; production passes nothing.
 */
export async function enrichRollupWithProviderQuota(
  rollup: UsageRollup,
  window: string,
  deps?: {
    reader?: RemainingQuotaReader
    loadProfiles?: () => Promise<AuthProfile[]>
    timeoutMs?: number
  },
): Promise<UsageRollup> {
  try {
    const reader = deps?.reader ?? new AnthropicRemainingQuotaReader()
    const profiles = await (deps?.loadProfiles ?? (() => listAuthProfiles()))()
    const byId = new Map(profiles.map(p => [p.id, p]))
    return await enrichWithRemainingQuota(rollup, {
      reader,
      resolveProfile: ref => {
        const profile = byId.get(ref)
        return profile ? toQuotaReadableProfile(profile) : undefined
      },
      window,
      ...(deps?.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    })
  } catch {
    return rollup
  }
}
