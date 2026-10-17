/**
 * PURE session-level report over a start-time window — "how many sessions
 * ran in the last 12h, by harness/model, how long, how much, which PRs, who's
 * still running". Companion to `usage-rollup.ts` but a different axis: that
 * module slices durable `usage_snapshot` DELTAS into a rolling spend window;
 * this module buckets whole SESSIONS by their own `startedAt`, using each
 * session's own (already cumulative-at-its-own-end) `costUsd`/tokens/duration
 * — simpler because a session's own total is never split across two windows.
 * Deliberately not reused from there: a different question ("what did this
 * session cost in total" vs "how much money moved in this window").
 *
 * Pure: no fs, no `Date.now`, no side effects — the caller (service layer)
 * collects sessions off the registry/disk and stamps the wall clock.
 *
 * Two sections are NOT window-filtered by design: `activeSessions` and
 * `permanentAgents` answer "what's true right now", not "what happened in
 * the window" — a permanent agent started weeks ago should still show up.
 */

import { parseTimeBound } from "./session-list-filters.js"

export interface SessionReportOpenedPr {
  adapter: string
  number: number
  url: string
  openedAt: string
}

/** The fields the reducer needs, projected off whatever the caller's source
 *  (live registry descriptor, cold sidecar) actually has. */
export interface SessionReportInput {
  id: string
  name?: string
  label?: string
  status: string
  alive?: boolean
  harness?: string
  model?: string
  startedAt: string
  endedAt?: string
  endedReason?: string
  /** A number only when a price was actually computed (never fabricated —
   *  see `UsageSource`'s "no-pricing"/"none" doctrine) — the priced/unpriced
   *  signal for the cost bucketing below. */
  costUsd?: number
  tokensIn?: number
  tokensOut?: number
  /** Resolved billing mode (`SessionAuthEcho.mode`) — absent when no
   *  credential resolved (every adapter besides claude-code, in practice). */
  authMode?: "subscription" | "api-key"
  keepAlive?: boolean
  openedPrs?: readonly SessionReportOpenedPr[]
}

export interface SessionReportCountEntry {
  key: string
  count: number
}

export interface SessionReportCostBucket {
  costUsd: number
  tokensIn: number
  tokensOut: number
  /** Token deltas from sessions whose cost is unpriced (pin: never a
   *  fabricated $0 — see `usage-rollup.ts`'s same doctrine). */
  unpricedTokens: number
  sessionCount: number
}

export interface SessionReportTopEntry {
  id: string
  name?: string
  harness?: string
  model?: string
  status: string
  costUsd?: number
  durationMs?: number
}

export interface SessionReportPrEntry {
  sessionId: string
  sessionName?: string
  adapter: string
  number: number
  url: string
  openedAt: string
}

export interface SessionReportActiveEntry {
  id: string
  name?: string
  harness?: string
  model?: string
  status: string
  startedAt: string
  keepAlive?: boolean
}

export interface SessionReport {
  since: string
  windowStart: string
  now: string
  totalSessions: number
  byHarness: SessionReportCountEntry[]
  byModel: SessionReportCountEntry[]
  byStatus: SessionReportCountEntry[]
  /** Keyed by the raw `endedReason` string (or `"unknown"` for a terminal
   *  session with none, `"running"` is never a key here — see `byStatus`). */
  byEndReason: SessionReportCountEntry[]
  duration: {
    /** Wall-clock elapsed (`endedAt ?? now` minus `startedAt`), summed. A
     *  still-running session counts its elapsed-so-far. */
    totalMs: number
    averageMs: number
    sessionCount: number
  }
  cost: {
    subscription: SessionReportCostBucket
    apiKey: SessionReportCostBucket
    unknown: SessionReportCostBucket
    total: SessionReportCostBucket
  }
  /** PRs opened by an in-window session. This is provenance ("opened during
   *  the window"), not a live GitHub state check — confirming still-open
   *  would mean one `gh`/API call per PR, which this pure/local reducer
   *  deliberately does not make. */
  openedPrs: SessionReportPrEntry[]
  topByCost: SessionReportTopEntry[]
  topByDuration: SessionReportTopEntry[]
  /** Currently alive sessions — NOT window-filtered (see module doc). */
  activeSessions: SessionReportActiveEntry[]
  /** Alive sessions with `keepAlive: true` — NOT window-filtered. */
  permanentAgents: SessionReportActiveEntry[]
}

function emptyCostBucket(): SessionReportCostBucket {
  return { costUsd: 0, tokensIn: 0, tokensOut: 0, unpricedTokens: 0, sessionCount: 0 }
}

function addCost(bucket: SessionReportCostBucket, s: SessionReportInput): void {
  bucket.sessionCount++
  // `costUsd` is only ever a number when a price was actually computed
  // (never fabricated — see `UsageSource`'s "no-pricing"/"none" doctrine in
  // usage.ts), so its presence alone is the priced/unpriced signal. Cold
  // sidecar-derived sessions (`session-cold-list.ts`) never echo
  // `usageSource` at all, so gating on that field too would silently drop
  // every cold session's real cost into `unpricedTokens`.
  if (typeof s.costUsd === "number") {
    bucket.costUsd += s.costUsd
    bucket.tokensIn += s.tokensIn ?? 0
    bucket.tokensOut += s.tokensOut ?? 0
  } else {
    bucket.unpricedTokens += (s.tokensIn ?? 0) + (s.tokensOut ?? 0)
  }
}

function addInto(target: SessionReportCostBucket, b: SessionReportCostBucket): void {
  target.costUsd += b.costUsd
  target.tokensIn += b.tokensIn
  target.tokensOut += b.tokensOut
  target.unpricedTokens += b.unpricedTokens
  target.sessionCount += b.sessionCount
}

function countBy(sessions: readonly SessionReportInput[], key: (s: SessionReportInput) => string | undefined): SessionReportCountEntry[] {
  const counts = new Map<string, number>()
  for (const s of sessions) {
    const k = key(s) ?? "unknown"
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([k, count]) => ({ key: k, count }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

function isAlive(s: SessionReportInput): boolean {
  return s.alive === true || s.status === "running" || s.status === "starting"
}

function elapsedMs(s: SessionReportInput, nowMs: number): number | undefined {
  const startMs = Date.parse(s.startedAt)
  if (Number.isNaN(startMs)) return undefined
  const endMs = s.endedAt !== undefined ? Date.parse(s.endedAt) : nowMs
  if (Number.isNaN(endMs)) return undefined
  return Math.max(0, endMs - startMs)
}

function toActiveEntry(s: SessionReportInput): SessionReportActiveEntry {
  return {
    id: s.id,
    ...(s.name !== undefined ? { name: s.name } : s.label !== undefined ? { name: s.label } : {}),
    ...(s.harness !== undefined ? { harness: s.harness } : {}),
    ...(s.model !== undefined ? { model: s.model } : {}),
    status: s.status,
    startedAt: s.startedAt,
    ...(s.keepAlive !== undefined ? { keepAlive: s.keepAlive } : {}),
  }
}

/**
 * Build the report. `sessions` is the FULL candidate set (not pre-filtered
 * by window) — `activeSessions`/`permanentAgents` deliberately read it
 * unfiltered; every other section filters to sessions whose `startedAt`
 * falls in `[now - since, now]` (via {@link parseTimeBound}'s vocabulary:
 * ISO-8601 or relative age like `"12h"`).
 */
export function buildSessionReport(
  sessions: readonly SessionReportInput[],
  opts: { since: string; nowMs?: number; topN?: number },
): SessionReport {
  const nowMs = opts.nowMs ?? Date.now()
  const windowStartMs = parseTimeBound(opts.since, "since", nowMs)
  const topN = opts.topN ?? 5

  const windowed = sessions.filter(s => {
    const startMs = Date.parse(s.startedAt)
    return !Number.isNaN(startMs) && startMs >= windowStartMs && startMs <= nowMs
  })

  const subscription = emptyCostBucket()
  const apiKey = emptyCostBucket()
  const unknown = emptyCostBucket()
  const total = emptyCostBucket()
  for (const s of windowed) {
    const bucket = s.authMode === "subscription" ? subscription : s.authMode === "api-key" ? apiKey : unknown
    addCost(bucket, s)
    addCost(total, s)
  }

  let totalDurationMs = 0
  let durationCount = 0
  const durations = new Map<string, number>()
  for (const s of windowed) {
    const ms = elapsedMs(s, nowMs)
    if (ms === undefined) continue
    durations.set(s.id, ms)
    totalDurationMs += ms
    durationCount++
  }

  const openedPrs: SessionReportPrEntry[] = windowed.flatMap(s =>
    (s.openedPrs ?? []).map(pr => ({
      sessionId: s.id,
      ...(s.name !== undefined ? { sessionName: s.name } : s.label !== undefined ? { sessionName: s.label } : {}),
      adapter: pr.adapter,
      number: pr.number,
      url: pr.url,
      openedAt: pr.openedAt,
    })),
  )

  const topByCost = [...windowed]
    .filter(s => typeof s.costUsd === "number")
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
    .slice(0, topN)
    .map(s => ({
      id: s.id,
      ...(s.name !== undefined ? { name: s.name } : s.label !== undefined ? { name: s.label } : {}),
      ...(s.harness !== undefined ? { harness: s.harness } : {}),
      ...(s.model !== undefined ? { model: s.model } : {}),
      status: s.status,
      ...(s.costUsd !== undefined ? { costUsd: s.costUsd } : {}),
      ...(durations.has(s.id) ? { durationMs: durations.get(s.id) } : {}),
    }))

  const topByDuration = [...windowed]
    .filter(s => durations.has(s.id))
    .sort((a, b) => (durations.get(b.id) ?? 0) - (durations.get(a.id) ?? 0))
    .slice(0, topN)
    .map(s => ({
      id: s.id,
      ...(s.name !== undefined ? { name: s.name } : s.label !== undefined ? { name: s.label } : {}),
      ...(s.harness !== undefined ? { harness: s.harness } : {}),
      ...(s.model !== undefined ? { model: s.model } : {}),
      status: s.status,
      ...(s.costUsd !== undefined ? { costUsd: s.costUsd } : {}),
      durationMs: durations.get(s.id)!,
    }))

  const activeSessions = sessions.filter(isAlive).map(toActiveEntry)
  const permanentAgents = sessions.filter(s => isAlive(s) && s.keepAlive === true).map(toActiveEntry)

  return {
    since: opts.since,
    windowStart: new Date(windowStartMs).toISOString(),
    now: new Date(nowMs).toISOString(),
    totalSessions: windowed.length,
    byHarness: countBy(windowed, s => s.harness),
    byModel: countBy(windowed, s => s.model),
    byStatus: countBy(windowed, s => s.status),
    byEndReason: countBy(
      windowed.filter(s => !isAlive(s)),
      s => s.endedReason,
    ),
    duration: {
      totalMs: totalDurationMs,
      averageMs: durationCount > 0 ? totalDurationMs / durationCount : 0,
      sessionCount: durationCount,
    },
    cost: { subscription, apiKey, unknown, total },
    openedPrs,
    topByCost,
    topByDuration,
    activeSessions,
    permanentAgents,
  }
}
