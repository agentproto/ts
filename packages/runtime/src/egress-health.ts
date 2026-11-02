/**
 * Egress IP health ledger. A free-tier model cap is enforced per source IP, so
 * "model M is capped" is really "model M is capped FROM THIS IP". The
 * model-cooldown map in `model-cooldowns.ts` forgets which IP failed, and
 * forgets everything on a restart. This ledger remembers `(publicIp, model,
 * errorClass) -> until` on disk (`~/.agentproto/egress-health.json`, or
 * `AGENTPROTO_EGRESS_HEALTH`), so a computer provider picking an egress slot
 * can skip an address that is already burned for the model, and the CLI can
 * show the same state without the daemon.
 *
 * Stateless over the file: every operation re-reads it, so the daemon, the CLI
 * and a probe run in another process all see one truth. Writes are best-effort
 * (tmp + rename, like `sandbox-ledger.ts`): a ledger failure must never fail a
 * spawn or a turn.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"
import type { SandboxEgressCooldown, SandboxEgressHealthView } from "@agentproto/sandbox"

/** The failure classes that burn an address for a model. */
export type EgressHealthErrorClass = "usage-limit" | "rate-limit"

export const isEgressHealthErrorClass = (value: unknown): value is EgressHealthErrorClass =>
  value === "usage-limit" || value === "rate-limit"

/** A usage cap outlives a burst limit: it clears on the provider's window, not in seconds. */
export const DEFAULT_EGRESS_COOLDOWN_MS: Record<EgressHealthErrorClass, number> = {
  "usage-limit": 60 * 60_000,
  "rate-limit": 10 * 60_000,
}
/** A longer hint than this is clamped so one bad header cannot park an address for days. */
export const MAX_EGRESS_COOLDOWN_MS = 6 * 60 * 60_000

export const egressHealthPath = (): string =>
  process.env.AGENTPROTO_EGRESS_HEALTH ?? resolve(homedir(), ".agentproto", "egress-health.json")

export interface EgressCooldownRecord {
  publicIp: string
  model: string
  errorClass: EgressHealthErrorClass
  /** Epoch ms the cooldown ends. */
  until: number
  /** Epoch ms it was recorded. */
  recordedAt: number
  /** Pool slot id, when the writer knew it. */
  slot?: string
  /** The session or probe whose failure recorded it. */
  source?: string
}

export interface EgressCooldownEntry {
  publicIp: string
  model: string
  errorClass: EgressHealthErrorClass
  /** ISO time the cooldown ends. */
  until: string
  remainingMs: number
  slot?: string
  source?: string
}

export interface MarkEgressCooldownInput {
  publicIp: string
  model: string
  errorClass: EgressHealthErrorClass
  durationMs?: number
  slot?: string
  source?: string
}

export interface EgressHealthLedger {
  /** Cool `(publicIp, model, errorClass)` down. Never shortens an active cooldown. */
  mark(input: MarkEgressCooldownInput): EgressCooldownEntry
  /** Drop the cooldowns for `(publicIp, model)`, one class or all. Returns how many were dropped. */
  clear(input: { publicIp: string; model: string; errorClass?: EgressHealthErrorClass }): number
  /** The longest active cooldown for `(publicIp, model)` across classes, if any. */
  cooling(publicIp: string, model: string): SandboxEgressCooldown | undefined
  /** A model-scoped read view for a provider choosing a slot. */
  view(model: string): SandboxEgressHealthView
  /** Active cooldowns, soonest-to-expire first; `model` narrows to one model. */
  list(opts?: { model?: string }): EgressCooldownEntry[]
}

const isRecord = (value: unknown): value is EgressCooldownRecord => {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.publicIp === "string" &&
    v.publicIp.length > 0 &&
    typeof v.model === "string" &&
    v.model.length > 0 &&
    isEgressHealthErrorClass(v.errorClass) &&
    typeof v.until === "number" &&
    typeof v.recordedAt === "number"
  )
}

let tmpSeq = 0

function readRecords(path: string): EgressCooldownRecord[] {
  try {
    const parsed: { cooldowns?: unknown } = JSON.parse(readFileSync(path, "utf8"))
    return Array.isArray(parsed.cooldowns) ? parsed.cooldowns.filter(isRecord) : []
  } catch {
    return []
  }
}

function writeRecords(path: string, records: readonly EgressCooldownRecord[]): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp.${process.pid}.${++tmpSeq}`
    writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), cooldowns: records }, null, 2) + "\n", "utf8")
    renameSync(tmp, path)
  } catch {
    // Best-effort, see the module doc.
  }
}

export function createEgressHealthLedger(opts: { path?: string; now?: () => number } = {}): EgressHealthLedger {
  const now = opts.now ?? Date.now
  const pathOf = (): string => opts.path ?? egressHealthPath()
  const live = (): EgressCooldownRecord[] => readRecords(pathOf()).filter(r => r.until > now())
  const project = (r: EgressCooldownRecord): EgressCooldownEntry => ({
    publicIp: r.publicIp,
    model: r.model,
    errorClass: r.errorClass,
    until: new Date(r.until).toISOString(),
    remainingMs: Math.max(0, r.until - now()),
    ...(r.slot ? { slot: r.slot } : {}),
    ...(r.source ? { source: r.source } : {}),
  })
  const same = (r: EgressCooldownRecord, i: { publicIp: string; model: string; errorClass?: EgressHealthErrorClass }): boolean =>
    r.publicIp === i.publicIp && r.model === i.model && (i.errorClass === undefined || r.errorClass === i.errorClass)

  const cooling = (publicIp: string, model: string): SandboxEgressCooldown | undefined => {
    let best: EgressCooldownRecord | undefined
    for (const r of live()) {
      if (same(r, { publicIp, model }) && (best === undefined || r.until > best.until)) best = r
    }
    return best ? { until: best.until, errorClass: best.errorClass } : undefined
  }

  return {
    mark(input) {
      const duration = Math.min(
        Math.max(input.durationMs ?? DEFAULT_EGRESS_COOLDOWN_MS[input.errorClass], 1),
        MAX_EGRESS_COOLDOWN_MS,
      )
      const at = now()
      const until = at + duration
      const records = live()
      const prev = records.find(r => same(r, input))
      const keepPrev = prev !== undefined && prev.until > until
      const next: EgressCooldownRecord = {
        publicIp: input.publicIp,
        model: input.model,
        errorClass: input.errorClass,
        until: keepPrev ? prev.until : until,
        recordedAt: keepPrev ? prev.recordedAt : at,
        ...(input.slot ? { slot: input.slot } : prev?.slot ? { slot: prev.slot } : {}),
        ...(input.source ? { source: input.source } : prev?.source ? { source: prev.source } : {}),
      }
      writeRecords(pathOf(), [...records.filter(r => !same(r, input)), next])
      return project(next)
    },
    clear(input) {
      const records = live()
      const kept = records.filter(r => !same(r, input))
      const dropped = records.length - kept.length
      if (dropped > 0) writeRecords(pathOf(), kept)
      return dropped
    },
    cooling,
    view: model => ({ model, cooling: publicIp => cooling(publicIp, model) }),
    list(listOpts) {
      return live()
        .filter(r => listOpts?.model === undefined || r.model === listOpts.model)
        .sort((a, b) => a.until - b.until)
        .map(project)
    },
  }
}

/** The process-wide ledger over the default path. The path is resolved per
 *  call, so a test (or an operator) can repoint `AGENTPROTO_EGRESS_HEALTH`. */
export const egressHealthLedger: EgressHealthLedger = createEgressHealthLedger()
