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

export const LIST_PAGE_LIMIT = 200
/** Pages fetched after the first one (so 3 × 200 = 600 rows per query max). */
export const LIST_EXTRA_PAGES = 2

const pageSuffix = n => `Page${n}`
const cursorId = (id, n) => `${id}Cursor${n}`

/** The page envelope out of a page-1 tool output or a map-collect output. */
function pageOf(out) {
  if (Array.isArray(out?.items)) return out
  const v = out?.results?.[0]?.value
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
        const cursor = pageOf(b.steps[from])?.nextCursor
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
    const page = pageOf(steps?.[key])
    if (!page) continue
    rows.push(...page.items)
    last = page
  }
  return { rows, truncated: Boolean(last?.nextCursor), total: pageOf(steps?.[id])?.total ?? rows.length }
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
