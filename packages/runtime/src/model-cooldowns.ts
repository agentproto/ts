/**
 * Daemon-wide model cooldowns. An OpenCode free-tier rate limit is per model
 * per IP, so one session being throttled on model M means EVERY session on
 * this daemon is throttled on M. The turn-retry controller records `M → until`
 * here when it classifies a turn as rate-limited, and rotation skips any model
 * still cooling down — for every session, not just the one that hit the limit.
 *
 * In-memory only: a daemon restart forgets it, and a limit that outlived the
 * restart is simply re-learned from the next 429.
 */

export const DEFAULT_MODEL_COOLDOWN_MS = 10 * 60_000
/** A `Retry-After` larger than this is clamped so one bad header cannot park a model for a day. */
export const MAX_MODEL_COOLDOWN_MS = 60 * 60_000

export interface ModelCooldownEntry {
  model: string
  /** ISO time the cooldown ends. */
  until: string
  remainingMs: number
  /** Why it was recorded (`rate-limit` / `no-output-stall`). */
  reason: string
  /** The session whose failure recorded it. */
  sessionId?: string
}

export interface ModelCooldowns {
  /** Cool `model` down for `durationMs` (clamped). Never shortens an active cooldown. */
  mark(model: string, opts: { durationMs?: number; reason: string; sessionId?: string }): ModelCooldownEntry
  /** Epoch ms the cooldown ends, or undefined when `model` is not cooling down. */
  until(model: string): number | undefined
  isCooling(model: string): boolean
  /** Active cooldowns, soonest-to-expire first. */
  list(): ModelCooldownEntry[]
}

export function createModelCooldowns(now: () => number = Date.now): ModelCooldowns {
  const entries = new Map<string, { until: number; reason: string; sessionId?: string }>()

  const live = (model: string) => {
    const e = entries.get(model)
    if (!e) return undefined
    if (e.until <= now()) {
      entries.delete(model)
      return undefined
    }
    return e
  }
  const project = (model: string, e: { until: number; reason: string; sessionId?: string }): ModelCooldownEntry => ({
    model,
    until: new Date(e.until).toISOString(),
    remainingMs: Math.max(0, e.until - now()),
    reason: e.reason,
    ...(e.sessionId ? { sessionId: e.sessionId } : {}),
  })

  return {
    mark(model, opts) {
      const duration = Math.min(Math.max(opts.durationMs ?? DEFAULT_MODEL_COOLDOWN_MS, 1), MAX_MODEL_COOLDOWN_MS)
      const until = now() + duration
      const prev = live(model)
      if (!prev || until > prev.until) {
        entries.set(model, {
          until,
          reason: opts.reason,
          ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        })
      }
      return project(model, entries.get(model)!)
    },
    until: model => live(model)?.until,
    isCooling: model => live(model) !== undefined,
    list() {
      for (const model of [...entries.keys()]) live(model)
      return [...entries.entries()]
        .sort((a, b) => a[1].until - b[1].until)
        .map(([model, e]) => project(model, e))
    },
  }
}
