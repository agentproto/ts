/**
 * AIP-46 delegation gate, observe first.
 *
 * The spawn authority for a nested spawn is the CALLING session's bound
 * agent `delegatesTo` (a closed allowlist, deny by default), resolved from
 * the caller's trusted identity. This module owns the pure decision, the
 * mode type, and the process-wide observer that counts what the gate would
 * refuse before an operator turns enforcement on.
 *
 * The observer is a module-level singleton on purpose: `spawnAgentSession`
 * is reached from agent-tools, http-server, session-tools and cron, which
 * share no object. Counters live in memory (a restart resets them); the
 * `console.warn` line for a would-deny pair is the durable record.
 */

export type DelegationGateMode = "off" | "observe" | "enforce"

export const DEFAULT_DELEGATION_GATE_MODE: DelegationGateMode = "observe"

/** What the gate concluded for one spawn. */
export type DelegationVerdict =
  | "allowed" // the caller's agent declares delegatesTo and the child is in it
  | "would_deny" // the caller's agent declares delegatesTo and the child is NOT in it
  | "undeclared" // the caller's agent declares no delegatesTo (pack role, manifest agent, unknown): the legacy rule applies
  | "unbound" // a trusted caller session exists but names no agent we can resolve
  | "no_caller" // no trusted caller: a root spawn, authorised by the host's own auth, not gated here

export interface DelegationInput {
  /** Trusted caller session id (callerScope.ownerSessionId, else the daemon-derived autoParentSessionId). NEVER the caller-supplied parentSessionId hint. */
  callerSessionId: string | undefined
  /** Slug of the caller's bound agent, when known. */
  callerAgent: string | undefined
  /** delegatesTo of the caller's agent when it DECLARES one (an explicit [] counts as declared); undefined when it declares none. */
  callerDelegatesTo: readonly string[] | undefined
  /** Slug of the child the spawn binds (the same expression session-spawn records as meta.agentSlug). */
  childAgent: string
}

/** The pure decision. No I/O, no configuration read. */
export function decideDelegation(input: DelegationInput): DelegationVerdict {
  if (input.callerSessionId === undefined) return "no_caller"
  if (input.callerAgent === undefined) return "unbound"
  if (input.callerDelegatesTo === undefined) return "undeclared"
  return input.callerDelegatesTo.includes(input.childAgent) ? "allowed" : "would_deny"
}

export interface DelegationReport {
  mode: DelegationGateMode
  /** ISO time this process started counting (resets on a restart: counters are in memory). */
  since: string
  counts: Record<DelegationVerdict, number>
  /** would_deny pairs, most frequent first, at most 50: caller agent -> child agent. */
  wouldDeny: Array<{ callerAgent: string; childAgent: string; count: number; lastAt: string }>
  /** unbound/undeclared callers by agent slug (or "(none)"), at most 50, most frequent first. */
  undeclaredAgents: Array<{ agent: string; count: number }>
}

const MAX_PAIRS = 200
const MAX_UNDECLARED_AGENTS = 200
const MAX_REPORT_ROWS = 50
const NONE = "(none)"

interface PairObservation {
  callerAgent: string
  childAgent: string
  count: number
  lastAt: string
}

let since = new Date().toISOString()
let counts: Record<DelegationVerdict, number> = emptyCounts()
let pairs = new Map<string, PairObservation>()
let undeclaredAgents = new Map<string, number>()

function emptyCounts(): Record<DelegationVerdict, number> {
  return {
    allowed: 0,
    would_deny: 0,
    undeclared: 0,
    unbound: 0,
    no_caller: 0,
  }
}

function pairKey(callerAgent: string, childAgent: string): string {
  return `${callerAgent}\u0000${childAgent}`
}

export function recordDelegation(
  verdict: DelegationVerdict,
  ctx: { mode: DelegationGateMode; callerAgent?: string; childAgent: string; surface: "scoped" | "mcp" },
): void {
  counts[verdict] += 1
  const callerAgent = ctx.callerAgent ?? NONE
  const at = new Date().toISOString()

  if (verdict === "would_deny") {
    const key = pairKey(callerAgent, ctx.childAgent)
    const existing = pairs.get(key)
    if (existing) {
      existing.count += 1
      existing.lastAt = at
    } else if (pairs.size < MAX_PAIRS) {
      pairs.set(key, { callerAgent, childAgent: ctx.childAgent, count: 1, lastAt: at })
    }
    // Past the cap a new pair is not tracked, but the verdict still counts.
    console.warn(
      `[delegation-gate] ${ctx.mode}: agent "${callerAgent}" would not be allowed to spawn "${ctx.childAgent}" (surface ${ctx.surface})`,
    )
    return
  }

  if (verdict === "undeclared" || verdict === "unbound") {
    const agent = ctx.callerAgent ?? NONE
    // Past the cap a new agent is not tracked, but the verdict still counts.
    if (undeclaredAgents.has(agent) || undeclaredAgents.size < MAX_UNDECLARED_AGENTS) {
      undeclaredAgents.set(agent, (undeclaredAgents.get(agent) ?? 0) + 1)
    }
  }
}

export function delegationReport(mode: DelegationGateMode): DelegationReport {
  const wouldDeny = [...pairs.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_REPORT_ROWS)
    .map(pair => ({ ...pair }))
  const undeclared = [...undeclaredAgents.entries()]
    .map(([agent, count]) => ({ agent, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_REPORT_ROWS)
  return {
    mode,
    since,
    counts: { ...counts },
    wouldDeny,
    undeclaredAgents: undeclared,
  }
}

/** Tests only: forget every observation and restart the `since` clock. */
export function resetDelegationObservations(): void {
  since = new Date().toISOString()
  counts = emptyCounts()
  pairs = new Map()
  undeclaredAgents = new Map()
}
