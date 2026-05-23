/**
 * Candidate state machine.
 *
 * AIP-18 collection COLLECTION.md declares the `statuses[]` array
 * with explicit `transitionsTo`. This module enforces those
 * transitions at the corpus-kit boundary so callers can never
 * silently land an item in an illegal state.
 *
 * The corpus' canonical candidate collection (per the plan) has:
 *
 *   discovered → analyzed | rejected
 *   analyzed   → approved | rejected | needs-work
 *   needs-work → analyzed | rejected
 *   approved   = terminal
 *   rejected   = terminal
 *
 * This module is pure (no I/O). The lifecycle workflow caller pairs
 * it with the writer + emitter to durably enact each transition.
 */

export type CandidateStatus =
  | "discovered"
  | "analyzed"
  | "needs-work"
  | "approved"
  | "rejected"

/**
 * Default transition graph mirroring the corpus-candidate AIP-18
 * collection shape shipped in the marketing preset. Hosts that load a
 * custom collection schema may override via
 * `transitionGraphFromCollection()`.
 */
export const DEFAULT_TRANSITIONS: Readonly<
  Record<CandidateStatus, readonly CandidateStatus[]>
> = Object.freeze({
  discovered: ["analyzed", "rejected"],
  analyzed: ["approved", "rejected", "needs-work"],
  "needs-work": ["analyzed", "rejected"],
  approved: [],
  rejected: [],
})

export interface TransitionCheck {
  readonly allowed: boolean
  readonly reason?: string
}

/**
 * Check whether a candidate can transition from `from` to `to`.
 */
export function canTransition(
  from: CandidateStatus,
  to: CandidateStatus,
  graph: Readonly<
    Record<CandidateStatus, readonly CandidateStatus[]>
  > = DEFAULT_TRANSITIONS
): TransitionCheck {
  if (from === to) {
    return { allowed: false, reason: "same-status (no-op)" }
  }
  const allowedTargets = graph[from] ?? []
  if (allowedTargets.length === 0) {
    return {
      allowed: false,
      reason: `"${from}" is terminal — no outgoing transitions`,
    }
  }
  if (!allowedTargets.includes(to)) {
    return {
      allowed: false,
      reason: `"${from}" cannot transition to "${to}". Allowed: ${allowedTargets.join(", ")}`,
    }
  }
  return { allowed: true }
}

/**
 * Build a transition graph from a parsed COLLECTION.md frontmatter.
 * Hosts call this once at boot to align the candidate state machine
 * with whatever collection schema the workspace ships.
 *
 * Falls back to DEFAULT_TRANSITIONS if the frontmatter doesn't carry
 * a recognizable `statuses[]` array — the caller is encouraged to
 * pass the parsed frontmatter directly rather than re-flattening.
 */
export function transitionGraphFromCollection(
  fm: Readonly<Record<string, unknown>>
): Readonly<Record<string, readonly string[]>> {
  const statuses = (fm.statuses ?? []) as readonly unknown[]
  const graph: Record<string, string[]> = {}
  for (const s of statuses) {
    if (typeof s !== "object" || s === null) continue
    const o = s as { id?: unknown; transitionsTo?: unknown; terminal?: unknown }
    if (typeof o.id !== "string") continue
    if (o.terminal === true) {
      graph[o.id] = []
      continue
    }
    if (Array.isArray(o.transitionsTo)) {
      graph[o.id] = (o.transitionsTo as unknown[]).filter(
        (x): x is string => typeof x === "string"
      )
    }
  }
  return Object.keys(graph).length > 0 ? Object.freeze(graph) : DEFAULT_TRANSITIONS
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: CandidateStatus,
    readonly to: CandidateStatus,
    readonly reason: string
  ) {
    super(
      `IllegalTransitionError: ${from} → ${to} is not allowed (${reason})`
    )
    this.name = "IllegalTransitionError"
  }
}

/**
 * Validate a transition and throw if disallowed. Convenience wrapper
 * around canTransition for callers that want fail-fast semantics.
 */
export function assertTransition(
  from: CandidateStatus,
  to: CandidateStatus,
  graph?: Readonly<Record<CandidateStatus, readonly CandidateStatus[]>>
): void {
  const check = canTransition(from, to, graph)
  if (!check.allowed) {
    throw new IllegalTransitionError(from, to, check.reason ?? "no reason")
  }
}
