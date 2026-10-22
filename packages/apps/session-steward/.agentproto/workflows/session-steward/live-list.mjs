// Slim, paged `session_list` reads for the steward workflows.
//
// A workflow persists every step output. `session_list {full:true}` over a
// ~1000-row registry stores every row's whole record (every
// `availableCommands` description included) on every run, which is what made
// workflow-runs.json grow without bound. The steward only reads a couple of
// dozen scalar fields per row, so it names them (`fields`), narrows the rows
// server-side (`onlyAlive` / `updatedSince`) and pages (`limit`/`cursor`).
// The steps below keep ONLY those projected pages; nothing downstream copies
// the merged list into a step output.

/** Every row field the steward reads (scan, never-ran, relabel, facts,
 *  fingerprint). Anything not listed is not fetched. */
export const LIVE_FIELDS = [
  "id",
  "name",
  "label",
  "status",
  "origin",
  "parentSessionId",
  "cwd",
  "model",
  "accessProfile",
  "startedAt",
  "lastActivityAt",
  "endedAt",
  "lastTurnErroredAt",
  "lastTurnErrorMessage",
  "lastError",
  "lastTurnReason",
  "turnsCompleted",
  "tokensIn",
  "tokensOut",
  "costUsd",
  "contextUsed",
  "busy",
  "pty",
  "pinned",
  "keepAlive",
  "archived",
  "provisioning",
  "pendingPrompts",
  "outcome",
  "wrapupFlag",
  "openedPrs",
  "worktree",
]

/** Rows per page. The MCP contract layer replaces any result over 100 000
 *  bytes with a `{truncated:true,…}` marker (`MCP_RESULT_MAX_BYTES`,
 *  `packages/mcp-server/src/to-mcp-tool.ts`). These 32 projected fields run
 *  ~1.3 KB/row on a real registry, so the old 200-row page serialized to
 *  ~256 KB and ALWAYS came back as that marker. 50 rows (~62 KB) leaves a
 *  wide margin even after a field grows. */
export const LIST_PAGE_LIMIT = 50
/** Pages fetched after the first one (so 16 × 50 = 800 rows per query max).
 *  The 72 h ended-window is ~570 rows today, and a page past the end costs
 *  only an empty transform (no tool call), so the extra steps are free. */
export const LIST_EXTRA_PAGES = 15

const pageSuffix = n => `Page${n}`
const cursorId = (id, n) => `${id}Cursor${n}`

const DEFAULT_TRUNCATED_HINT = "use limit/cursor/fields"

/** The daemon's over-cap marker, if `v` is one. */
function truncatedMarkerOf(v) {
  if (!v || typeof v !== "object" || v.truncated !== true) return null
  return {
    totalBytes: typeof v.totalBytes === "number" ? v.totalBytes : 0,
    hint: typeof v.hint === "string" && v.hint ? v.hint : DEFAULT_TRUNCATED_HINT,
  }
}

/** The page envelope out of a page-1 tool output or a map-collect output.
 *
 *  A page replaced by the daemon's truncation marker is NOT an empty page.
 *  Treating one as "no rows" is what made the steward scan 0-2 of 538
 *  terminal sessions (`terminal: 0`, no archive proposed) — but `truncated`
 *  is only ever a hint to re-page, never a result. Throw so the run fails
 *  visibly instead of silently classifying an empty fleet. */
function pageOf(out, what = "session_list") {
  if (Array.isArray(out?.items)) return out
  const v = out?.results?.[0]?.value
  const marker = truncatedMarkerOf(out) ?? truncatedMarkerOf(v)
  if (marker) {
    throw new Error(
      `${what} page was truncated by the MCP result cap (${marker.totalBytes} bytes; hint: ${marker.hint}) — refusing to treat it as an empty page`,
    )
  }
  return Array.isArray(v?.items) ? v : null
}

/** `updatedSince` for the ended-sessions query: the relabel window (or the
 *  wider `listWindowHours` when the run also looks for archivable rows). */
export function listWindow(settings) {
  const hours = Math.max(1, Math.ceil(Number(settings?.listWindowHours ?? settings?.relabelWindowHours) || 24))
  return { updatedSince: `${hours}h` }
}

/**
 * Steps reading one filtered, projected, paged `session_list` query. Page 1
 * keeps `id`; later pages are a cursor transform plus a map that runs once
 * (or not at all when the previous page had no `nextCursor`).
 */
export function pagedListSteps(id, filter) {
  const base = { ...filter, fields: LIVE_FIELDS, limit: LIST_PAGE_LIMIT }
  const steps = [{ id, kind: "tool", tool: "session_list", inputs: base }]
  let prev = id
  for (let n = 2; n <= LIST_EXTRA_PAGES + 1; n++) {
    const from = prev
    steps.push({
      id: cursorId(id, n),
      kind: "transform",
      compute: b => {
        const cursor = pageOf(b.steps[from], from)?.nextCursor
        return cursor ? [{ cursor }] : []
      },
    })
    const pageId = `${id}${pageSuffix(n)}`
    steps.push({
      id: pageId,
      kind: "map",
      over: `$steps.${cursorId(id, n)}`,
      parallelism: 1,
      onError: "collect",
      steps: [{ id: `${pageId}Fetch`, kind: "tool", tool: "session_list", inputs: { ...base, cursor: "$item.cursor" } }],
    })
    prev = pageId
  }
  return steps
}

/** `{ rows, truncated, total }` for one query's pages. */
export function pagedRows(steps, id) {
  const rows = []
  let last = null
  const ids = [id]
  for (let n = 2; n <= LIST_EXTRA_PAGES + 1; n++) ids.push(`${id}${pageSuffix(n)}`)
  for (const key of ids) {
    const page = pageOf(steps?.[key], key)
    if (!page) continue
    rows.push(...page.items)
    last = page
  }
  return { rows, truncated: Boolean(last?.nextCursor), total: pageOf(steps?.[id], id)?.total ?? rows.length }
}

/** Rows of several queries, de-duplicated by id (first query wins). */
export function mergeRows(...lists) {
  const seen = new Set()
  const out = []
  for (const list of lists) {
    for (const row of list) {
      if (!row?.id || seen.has(row.id)) continue
      seen.add(row.id)
      out.push(row)
    }
  }
  return out
}

/** The two listing queries behind a scan: live rows, and the recently active
 *  rows (covers sessions that ended inside the relabel window). */
export function liveListSteps() {
  return [
    { id: "listWindow", kind: "transform", compute: b => listWindow(b.steps.settings) },
    ...pagedListSteps("liveSessions", { onlyAlive: true }),
    ...pagedListSteps("endedSessions", { updatedSince: "$steps.listWindow.updatedSince" }),
  ]
}

/** The `{ sessions, truncated }` view of both queries, for `scanLive`. */
export function scannedRows(steps) {
  const live = pagedRows(steps, "liveSessions")
  const ended = pagedRows(steps, "endedSessions")
  return { sessions: mergeRows(live.rows, ended.rows), truncated: live.truncated || ended.truncated }
}
