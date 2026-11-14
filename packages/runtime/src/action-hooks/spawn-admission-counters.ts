/**
 * Process-wide counters for the `builtin:spawn-admission` decisions.
 *
 * Counters are a module-level singleton on purpose, for the same reason as
 * `delegation-gate.ts`: `spawnAgentSession` is reached from agent-tools,
 * http-server, session-tools and cron, which share no object. Counts live in
 * memory (a restart resets them); one `[spawn-admission]` line per non-allow
 * decision is the durable record.
 *
 * Counts only. A label, a session id (`targetId`), a cwd, a message and a
 * prompt never enter the counters or the log line.
 */

import type { AdmissionDecision } from "./types.js"
import type { SpawnAdmissionCheck, SpawnDedupeSource } from "./spawn-admission.js"

export type SpawnAdmissionStage = SpawnAdmissionCheck["stage"]
export type SpawnAdmissionOutcome = AdmissionDecision["outcome"]

export interface SpawnAdmissionEvent {
  stage: SpawnAdmissionStage
  decision: AdmissionDecision
  dedupeSource?: SpawnDedupeSource
}

export interface SpawnAdmissionReport {
  /** ISO time this process started counting (counters are in memory; a restart resets them). */
  since: string
  /** Every evaluated decision. */
  total: number
  /** Per stage, per outcome. Every stage and every outcome is present, zero when unseen. */
  stages: Record<SpawnAdmissionStage, Record<SpawnAdmissionOutcome, number>>
  /** reuse decisions by what matched: explicit key, implicit key, worktree cwd. */
  dedupeSources: Record<SpawnDedupeSource, number>
  /** Non-allow decisions by stage/outcome/code, most frequent first, at most 50. */
  codes: Array<{ stage: SpawnAdmissionStage; outcome: SpawnAdmissionOutcome; code: string; count: number }>
}

const STAGES: readonly SpawnAdmissionStage[] = [
  "claim",
  "worktree-policy",
  "worktree-collision-sync",
  "worktree-collision-async",
]

const OUTCOMES: readonly SpawnAdmissionOutcome[] = ["allow", "deny", "reuse", "defer"]

const DEDUPE_SOURCES: readonly SpawnDedupeSource[] = ["explicit", "implicit", "worktree-cwd"]

const MAX_CODE_KEYS = 100
const MAX_REPORT_ROWS = 50

interface CodeObservation {
  stage: SpawnAdmissionStage
  outcome: SpawnAdmissionOutcome
  code: string
  count: number
}

let since = new Date().toISOString()
let total = 0
let stages = emptyStages()
let dedupeSources = emptyDedupeSources()
let codes = new Map<string, CodeObservation>()

function emptyStages(): Record<SpawnAdmissionStage, Record<SpawnAdmissionOutcome, number>> {
  return Object.fromEntries(
    STAGES.map(stage => [stage, Object.fromEntries(OUTCOMES.map(outcome => [outcome, 0]))]),
  ) as Record<SpawnAdmissionStage, Record<SpawnAdmissionOutcome, number>>
}

function emptyDedupeSources(): Record<SpawnDedupeSource, number> {
  return Object.fromEntries(DEDUPE_SOURCES.map(source => [source, 0])) as Record<SpawnDedupeSource, number>
}

function codeKey(stage: SpawnAdmissionStage, outcome: SpawnAdmissionOutcome, code: string): string {
  return `${stage}\u0000${outcome}\u0000${code}`
}

export function recordSpawnAdmission(event: SpawnAdmissionEvent): void {
  const { stage, decision, dedupeSource } = event
  total += 1
  stages[stage][decision.outcome] += 1

  if (decision.outcome === "reuse" && dedupeSource) dedupeSources[dedupeSource] += 1

  if (decision.outcome === "allow") return

  const key = codeKey(stage, decision.outcome, decision.code)
  const existing = codes.get(key)
  if (existing) {
    existing.count += 1
  } else if (codes.size < MAX_CODE_KEYS) {
    codes.set(key, { stage, outcome: decision.outcome, code: decision.code, count: 1 })
  }
  // Past the cap a new key is not tracked, but the decision and its totals
  // still count.

  const source = dedupeSource ? ` source=${dedupeSource}` : ""
  console.log(`[spawn-admission] stage=${stage} outcome=${decision.outcome} code=${decision.code}${source}`)
}

export function spawnAdmissionReport(): SpawnAdmissionReport {
  return {
    since,
    total,
    stages: Object.fromEntries(
      STAGES.map(stage => [stage, { ...stages[stage] }]),
    ) as Record<SpawnAdmissionStage, Record<SpawnAdmissionOutcome, number>>,
    dedupeSources: { ...dedupeSources },
    codes: [...codes.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_REPORT_ROWS)
      .map(row => ({ ...row })),
  }
}

/** Tests only. */
export function resetSpawnAdmissionCounters(): void {
  since = new Date().toISOString()
  total = 0
  stages = emptyStages()
  dedupeSources = emptyDedupeSources()
  codes = new Map()
}
