/**
 * PURE, provider-agnostic spend rollup over durable `usage_snapshot`
 * transcript records — "how much did profile X / model Y / harness Z spend in
 * the last 5h / 7d?".
 *
 * This module is intentionally pure: no fs, no `Date.now`, no side effects. It
 * takes an injected clock (`opts.nowMs`) and hand-collected snapshots so the
 * whole reduction is unit-testable without touching disk. The surface layer
 * (MCP tool / REST route / CLI, built on top of these exports) is responsible
 * for reading snapshots off disk and stamping the wall clock.
 *
 * Four correctness pins this module MUST uphold — the tests would fail if any
 * were violated:
 *
 *  1. CUMULATIVE, not deltas. Every `usage_snapshot` carries the descriptor's
 *     CUMULATIVE `costUsd`/`tokensIn`/`tokensOut` (see `buildUsageSnapshot` in
 *     sessions.ts), written every turn-end AND at exit. Summing snapshots would
 *     double-count. A session's window value per field is
 *     `latest-in-window − last-snapshot-at-or-before-window-start` (baseline 0
 *     when the session's first snapshot is itself inside the window).
 *
 *  2. `no-pricing` / `none` snapshots contribute ZERO dollars. Their tokens go
 *     into a separate `unpricedTokens` bucket — never a fabricated 0-cost, and
 *     never re-priced here. Snapshots were already priced authoritatively at
 *     write-time (`deriveSessionUsage`); this module SUMS pre-computed `costUsd`
 *     deltas and never re-prices. Re-pricing would invent dollars for an
 *     unpriced model.
 *
 *  3. Windows are ROLLING: `[now − duration, now]`.
 *
 *  4. The rollup is a priced ESTIMATE, tagged `basis: "local-estimate"`.
 */

/** A single durable `usage_snapshot` record, projected to the fields the
 *  rollup needs. `source` decides priced vs unpriced (see pin 2). Cost/token
 *  fields are optional because the writer omits absent ones so a missing value
 *  never reads as a measured 0. */
export type UsageSnapshotRecord = {
  ts: string
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  model?: string
  source: "adapter" | "computed" | "no-pricing" | "none"
}

/** All snapshots for one session plus the attribution keys the caller resolved
 *  off the session descriptor (`desc.accessProfile?.profileRef`,
 *  `desc.harness ?? desc.adapterSlug`). */
export interface SessionSnapshots {
  sessionId: string
  profileRef?: string
  harness?: string
  snapshots: UsageSnapshotRecord[]
}

/** A summed spend bucket. `spentUsd` counts only priced snapshots; unpriced
 *  token deltas land in `unpricedTokens` (pin 2). */
export interface UsageBucket {
  spentUsd: number
  tokensIn: number
  tokensOut: number
  unpricedTokens: number
}

export interface UsageRollup {
  window: string
  windowMs: number
  basis: "local-estimate"
  now: string
  windowStart: string
  total: UsageBucket
  byProfile: Array<{ profileRef: string } & UsageBucket>
  byModel: Array<{ model: string } & UsageBucket>
  byHarness: Array<{ harness: string } & UsageBucket>
  sessionsConsidered: number
}

const MS_S = 1_000
const MS_M = 60_000
const MS_H = 3_600_000
const MS_D = 86_400_000
const MS_W = 604_800_000

/** Milliseconds for a single shorthand unit char. `undefined` for an unknown
 *  char — the regexes only ever pass `s|m|h|d|w`, but this keeps the lookup
 *  total under `noUncheckedIndexedAccess`. */
function unitMs(unit: string): number | undefined {
  switch (unit) {
    case "s":
      return MS_S
    case "m":
      return MS_M
    case "h":
      return MS_H
    case "d":
      return MS_D
    case "w":
      return MS_W
    default:
      return undefined
  }
}

/**
 * Parse a rolling-window spec into milliseconds.
 *
 * Accepts two forms:
 *  - shorthand `<int><s|m|h|d|w>` — e.g. "5h", "7d", "30m", "2w"
 *  - ISO-8601 durations — e.g. "P7D", "PT5H", "P1DT12H", "PT30M"
 *
 * Returns `{ error }` for anything unparseable or non-positive. Deliberately
 * NOT reused from the CLI's `util/duration.ts` — that one is ms-based, has no
 * days/weeks, and rejects the bare-shorthand semantics we need here.
 */
export function parseWindow(w: string): { ms: number } | { error: string } {
  const raw = typeof w === "string" ? w.trim() : ""
  if (!raw) return { error: "empty window" }

  // Shorthand: <int><unit>, unit ∈ s|m|h|d|w
  const short = /^(\d+)([smhdw])$/.exec(raw)
  if (short) {
    const value = Number(short[1])
    const per = unitMs(short[2] ?? "")
    if (per === undefined) return { error: `unparseable window: ${w}` }
    const ms = value * per
    if (!(ms > 0)) return { error: `non-positive window: ${w}` }
    return { ms }
  }

  // ISO-8601 duration. Only the day/time components are meaningful for a
  // rolling spend window — years and months are calendar-relative and
  // deliberately unsupported (a "spend in the last month" would be ambiguous).
  const iso = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(raw)
  if (iso) {
    const [, wk, d, h, m, s] = iso
    // A bare "P" or "PT" (all groups absent) is not a valid duration.
    if (!wk && !d && !h && !m && !s) return { error: `unparseable window: ${w}` }
    const ms =
      (wk ? Number(wk) * MS_W : 0) +
      (d ? Number(d) * MS_D : 0) +
      (h ? Number(h) * MS_H : 0) +
      (m ? Number(m) * MS_M : 0) +
      (s ? Number(s) * MS_S : 0)
    if (!(ms > 0)) return { error: `non-positive window: ${w}` }
    return { ms }
  }

  return { error: `unparseable window: ${w}` }
}

/** `0` for a non-number, else the number itself — a missing cumulative field
 *  reads as "unmeasured, treat as 0" for delta math. */
function num(x: number | undefined): number {
  return typeof x === "number" ? x : 0
}

function emptyBucket(): UsageBucket {
  return { spentUsd: 0, tokensIn: 0, tokensOut: 0, unpricedTokens: 0 }
}

function addInto(target: UsageBucket, b: UsageBucket): void {
  target.spentUsd += b.spentUsd
  target.tokensIn += b.tokensIn
  target.tokensOut += b.tokensOut
  target.unpricedTokens += b.unpricedTokens
}

/** Group buckets by a key, sum each group, then sort `spentUsd` desc, key asc,
 *  for deterministic output. */
function groupBy<K extends string>(
  entries: Array<{ key: string; bucket: UsageBucket }>,
  keyField: K,
): Array<Record<K, string> & UsageBucket> {
  const groups = new Map<string, UsageBucket>()
  for (const { key, bucket } of entries) {
    let acc = groups.get(key)
    if (!acc) {
      acc = emptyBucket()
      groups.set(key, acc)
    }
    addInto(acc, bucket)
  }
  return Array.from(groups.entries())
    .map(([key, bucket]) => ({ [keyField]: key, ...bucket }) as Record<K, string> & UsageBucket)
    .sort((a, b) => b.spentUsd - a.spentUsd || (a[keyField] < b[keyField] ? -1 : a[keyField] > b[keyField] ? 1 : 0))
}

/**
 * Roll up per-session cumulative snapshots into a windowed spend estimate.
 *
 * `sessionsConsidered` counts only sessions that contributed at least one
 * in-window snapshot — a session whose snapshots all fall outside the window
 * is skipped entirely and does NOT count. (A session present only as a
 * pre-window baseline contributes no delta and no bucket, so counting it would
 * overstate "how many sessions spent in this window".)
 *
 * Throws on a `parseWindow` error: the surface layer validates the window
 * before calling, but a clear throw guards a direct/misuse call.
 */
export function rollupUsage(
  sessions: SessionSnapshots[],
  opts: { window: string; nowMs: number },
): UsageRollup {
  const parsed = parseWindow(opts.window)
  if ("error" in parsed) {
    throw new Error(`rollupUsage: invalid window "${opts.window}": ${parsed.error}`)
  }
  const windowMs = parsed.ms
  const nowMs = opts.nowMs
  const windowStartMs = nowMs - windowMs

  const total = emptyBucket()
  const byProfileEntries: Array<{ key: string; bucket: UsageBucket }> = []
  const byModelEntries: Array<{ key: string; bucket: UsageBucket }> = []
  const byHarnessEntries: Array<{ key: string; bucket: UsageBucket }> = []
  let sessionsConsidered = 0

  for (const session of sessions) {
    // Sort ascending by parsed timestamp; drop unparseable timestamps.
    const sorted = session.snapshots
      .map(s => ({ s, tsMs: Date.parse(s.ts) }))
      .filter(({ tsMs }) => !Number.isNaN(tsMs))
      .sort((a, b) => a.tsMs - b.tsMs)

    const inWindow = sorted.filter(({ tsMs }) => tsMs >= windowStartMs && tsMs <= nowMs)
    const latestEntry = inWindow[inWindow.length - 1]
    if (latestEntry === undefined) continue // no in-window snapshot → not counted

    sessionsConsidered++

    const latest = latestEntry.s
    // Baseline = last snapshot strictly before the window start (undefined when
    // the session's first snapshot is inside the window → baseline 0).
    const beforeWindow = sorted.filter(({ tsMs }) => tsMs < windowStartMs)
    const baseline = beforeWindow[beforeWindow.length - 1]?.s

    // Clamp negative deltas to 0: cumulative fields should be monotonic; a
    // non-monotonic anomaly must never subtract from the total.
    const costDelta = Math.max(0, num(latest.costUsd) - num(baseline?.costUsd))
    const tokInDelta = Math.max(0, num(latest.tokensIn) - num(baseline?.tokensIn))
    const tokOutDelta = Math.max(0, num(latest.tokensOut) - num(baseline?.tokensOut))

    // Priced vs unpriced is decided by whether the LATEST snapshot carries a
    // real cost number (adapter/computed) — never re-priced here (pin 2).
    const priced = typeof latest.costUsd === "number"
    const bucket = emptyBucket()
    if (priced) {
      bucket.spentUsd = costDelta
      bucket.tokensIn = tokInDelta
      bucket.tokensOut = tokOutDelta
    } else {
      // Unpriced: 0 dollars, tokens accumulate in the separate bucket.
      bucket.unpricedTokens = tokInDelta + tokOutDelta
    }

    addInto(total, bucket)
    byProfileEntries.push({ key: session.profileRef ?? "unknown", bucket })
    byHarnessEntries.push({ key: session.harness ?? "unknown", bucket })
    byModelEntries.push({ key: latest.model ?? "unknown", bucket })
  }

  return {
    window: opts.window,
    windowMs,
    basis: "local-estimate",
    now: new Date(nowMs).toISOString(),
    windowStart: new Date(windowStartMs).toISOString(),
    total,
    byProfile: groupBy(byProfileEntries, "profileRef"),
    byModel: groupBy(byModelEntries, "model"),
    byHarness: groupBy(byHarnessEntries, "harness"),
    sessionsConsidered,
  }
}
