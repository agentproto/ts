/**
 * AIP-46 auth-profile gate, observe first.
 *
 * A spawn may name an auth profile (`access.profileRef` / `access.profileRefs`).
 * The spawn authority is the CALLING session's own profile set: its recorded
 * `accessProfile.profileRef` plus the operator-configured
 * `defaults.spawn.sharedProfiles`. This module owns the pure decision, the
 * mode type, and the process-wide observer that counts what the gate would
 * refuse before an operator turns enforcement on.
 *
 * The observer is a module-level singleton on purpose: `spawnAgentSession`
 * is reached from agent-tools, http-server, session-tools and cron, which
 * share no object. Counters live in memory (a restart resets them); the
 * `console.warn` line for a would-deny pair is the durable record.
 */

import type { SessionDescriptor } from "./sessions.js"

export type ProfileGateMode = "off" | "observe" | "enforce"

export const DEFAULT_PROFILE_GATE_MODE: ProfileGateMode = "observe"

/** What the gate concluded for one spawn. */
export type ProfileVerdict =
  | "allowed" // every requested profile is in the caller's set
  | "would_deny" // at least one requested profile is not in the caller's set
  | "unnamed" // the request names no profile
  | "no_caller" // no trusted caller: a root spawn, authorised by the host's own auth, not gated
  | "caller_unknown" // a trusted caller id the registry does not hold (not gated, counted)
  | "external" // the caller is an external label (AIP-46 rule 7): evaluated as anonymous, not gated

/**
 * The caller's profile set: its own recorded `accessProfile.profileRef` plus
 * every `defaults.spawn.sharedProfiles` entry, deduped. The caller's own
 * profile comes first, so a report row can name it.
 */
export function callerProfileSet(input: {
  caller: Pick<SessionDescriptor, "accessProfile"> | undefined
  shared: readonly string[] | undefined
}): string[] {
  const out: string[] = []
  const own = input.caller?.accessProfile?.profileRef
  if (own !== undefined && own !== "") out.push(own)
  for (const ref of input.shared ?? []) {
    if (ref !== "" && !out.includes(ref)) out.push(ref)
  }
  return out
}

export interface ProfileDecisionInput {
  /** Trusted caller session id (callerScope.ownerSessionId, else the daemon-derived autoParentSessionId). NEVER the caller-supplied parentSessionId hint. */
  callerSessionId: string | undefined
  /** Whether the registry holds that caller id. */
  callerKnown: boolean
  /** The caller is a `kind: "external"` row: a label the host did not spawn (AIP-46 rule 7). It is evaluated as anonymous, so it is never gated. */
  callerExternal?: boolean
  /** The profiles the REQUEST names, deduped, empty strings dropped. */
  requested: readonly string[]
  /** {@link callerProfileSet} for this caller. */
  callerProfiles: readonly string[]
}

/** The pure decision. No I/O, no configuration read. */
export function decideProfileUse(input: ProfileDecisionInput): {
  verdict: ProfileVerdict
  denied: string[]
} {
  if (input.callerSessionId === undefined) return { verdict: "no_caller", denied: [] }
  if (!input.callerKnown) return { verdict: "caller_unknown", denied: [] }
  if (input.callerExternal === true) return { verdict: "external", denied: [] }
  if (input.requested.length === 0) return { verdict: "unnamed", denied: [] }
  const denied: string[] = []
  for (const ref of input.requested) {
    if (!input.callerProfiles.includes(ref) && !denied.includes(ref)) denied.push(ref)
  }
  return denied.length > 0 ? { verdict: "would_deny", denied } : { verdict: "allowed", denied: [] }
}

export interface ProfileReport {
  mode: ProfileGateMode
  /** ISO time this process started counting (resets on a restart: counters are in memory). */
  since: string
  counts: Record<ProfileVerdict, number>
  /** would_deny pairs, most frequent first, at most 50: caller profile -> requested profile. */
  wouldDeny: Array<{ callerProfile: string; requestedProfile: string; count: number; lastAt: string }>
}

const MAX_PAIRS = 200
const MAX_REPORT_ROWS = 50
const NONE = "(none)"

interface PairObservation {
  callerProfile: string
  requestedProfile: string
  count: number
  lastAt: string
}

let since = new Date().toISOString()
let counts: Record<ProfileVerdict, number> = emptyCounts()
let pairs = new Map<string, PairObservation>()

function emptyCounts(): Record<ProfileVerdict, number> {
  return {
    allowed: 0,
    would_deny: 0,
    unnamed: 0,
    no_caller: 0,
    caller_unknown: 0,
    external: 0,
  }
}

function pairKey(callerProfile: string, requestedProfile: string): string {
  return `${callerProfile}\u0000${requestedProfile}`
}

export function recordProfileUse(
  verdict: ProfileVerdict,
  ctx: {
    mode: ProfileGateMode
    callerProfiles: readonly string[]
    denied: readonly string[]
    surface: "scoped" | "mcp"
  },
): void {
  counts[verdict] += 1
  if (verdict !== "would_deny") return
  const callerProfile = ctx.callerProfiles[0] ?? NONE
  const at = new Date().toISOString()
  for (const requestedProfile of ctx.denied) {
    const key = pairKey(callerProfile, requestedProfile)
    const existing = pairs.get(key)
    if (existing) {
      existing.count += 1
      existing.lastAt = at
    } else if (pairs.size < MAX_PAIRS) {
      pairs.set(key, { callerProfile, requestedProfile, count: 1, lastAt: at })
      // One warning the FIRST time a pair is seen; the count carries the rest.
      console.warn(
        `[profile-gate] ${ctx.mode}: a session on profile "${callerProfile}" named profile "${requestedProfile}" (surface ${ctx.surface})`,
      )
    }
    // Past the cap a new pair is not tracked, but the verdict still counts.
  }
}

export function profileReport(mode: ProfileGateMode): ProfileReport {
  const wouldDeny = [...pairs.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_REPORT_ROWS)
    .map(pair => ({ ...pair }))
  return {
    mode,
    since,
    counts: { ...counts },
    wouldDeny,
  }
}

/** Tests only: forget every observation and restart the `since` clock. */
export function resetProfileObservations(): void {
  since = new Date().toISOString()
  counts = emptyCounts()
  pairs = new Map()
}
