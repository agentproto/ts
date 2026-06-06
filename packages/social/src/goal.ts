/**
 * Goal harness — capture UNTIL an objective is met, not for a fixed count.
 *
 * `limit`/depth bound each slice; the goal bounds the WHOLE run. The harness
 * streams the adapter's footprint, tallies as records arrive, and aborts (via
 * the AbortSignal the adapters already check between pages) the moment the
 * goal is satisfied — so "200 authored AND 500 connections", "1k records
 * total", or a custom predicate stops early instead of paginating to the cap.
 */

import type { FootprintRecord, Slice } from "./model/footprint.js"
import { sliceOf } from "./model/footprint.js"
import type { SocialSourcePort } from "./ports/social-source.port.js"
import type { DepthSettings } from "./depth.js"
import { resolveDepth, type DepthName } from "./depth.js"

export interface GoalTally {
  total: number
  bySlice: Record<Slice, number>
  byKind: Record<FootprintRecord["kind"], number>
}

export interface CaptureGoal {
  /** Stop once EVERY listed slice has reached its target. */
  readonly perSlice?: Partial<Record<Slice, number>>
  /** Stop once this many records (any slice) have been captured. */
  readonly maxRecords?: number
  /** Custom stop predicate over the running tally — full control. */
  readonly stopWhen?: (tally: GoalTally) => boolean
}

export interface CaptureToGoalOptions {
  readonly slices: readonly Slice[]
  /** Depth profile name, overrides, or settings. Bounds each slice. */
  readonly depth?: DepthName | Partial<DepthSettings> | DepthSettings
  readonly goal?: CaptureGoal
  /** Caller cancellation, chained with the harness's internal abort. */
  readonly signal?: AbortSignal
}

export interface CaptureToGoalResult {
  readonly records: FootprintRecord[]
  readonly profile?: Extract<FootprintRecord, { kind: "profile" }>
  readonly tally: GoalTally
  /** True when the goal was satisfied (vs. the adapter simply running dry). */
  readonly metGoal: boolean
  readonly depth: DepthSettings
}

function emptyTally(): GoalTally {
  return {
    total: 0,
    bySlice: { authored: 0, "engagement-given": 0, "engagement-received": 0, connections: 0 },
    byKind: { profile: 0, post: 0, "engagement-given": 0, "engagement-received": 0, connection: 0 },
  }
}

function goalMet(goal: CaptureGoal | undefined, tally: GoalTally): boolean {
  if (!goal) return false
  if (goal.stopWhen?.(tally)) return true
  if (goal.maxRecords != null && tally.total >= goal.maxRecords) return true
  if (goal.perSlice) {
    const targets = Object.entries(goal.perSlice) as Array<[Slice, number]>
    if (targets.length > 0 && targets.every(([s, n]) => tally.bySlice[s] >= n)) return true
  }
  return false
}

/**
 * Drive an adapter to a goal. Without a goal it behaves like a plain capture
 * bounded by depth. Returns the buffered footprint + the tally + whether the
 * goal was reached — ready to fan out to the corpus + graph sinks.
 */
export async function captureToGoal(
  port: SocialSourcePort,
  handle: string,
  opts: CaptureToGoalOptions
): Promise<CaptureToGoalResult> {
  const depth = resolveDepth(opts.depth)
  const controller = new AbortController()
  const onParentAbort = () => controller.abort()
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener("abort", onParentAbort, { once: true })
  }

  const records: FootprintRecord[] = []
  const tally = emptyTally()
  let profile: CaptureToGoalResult["profile"]
  let metGoal = false

  try {
    for await (const record of port.capture(handle, {
      slices: opts.slices,
      limit: depth.limit,
      signal: controller.signal,
    })) {
      records.push(record)
      if (record.kind === "profile" && !profile) profile = record
      tally.total++
      tally.bySlice[sliceOf(record)]++
      tally.byKind[record.kind]++
      if (goalMet(opts.goal, tally)) {
        metGoal = true
        controller.abort() // adapters check signal between pages → prompt stop
        break
      }
    }
  } finally {
    if (opts.signal) opts.signal.removeEventListener("abort", onParentAbort)
  }

  return { records, profile, tally, metGoal, depth }
}
