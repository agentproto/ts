/**
 * An in-memory `session_list` that honors the daemon contract the steward
 * relies on: `onlyAlive` / `status` / `updatedSince` / `q` narrowing, newest-activity
 * first, `fields` as an allowlist on the FULL record, and `limit` / `cursor`
 * paging (`{ items, nextCursor?, total }`). Without `limit` / `cursor` it
 * returns the legacy `{ sessions, total }` wrapper, like the real tool.
 */

type Row = Record<string, unknown>

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

function boundMs(raw: string, nowMs: number): number {
  const rel = /^(\d+(?:\.\d+)?)\s*([smhdw])$/i.exec(raw.trim())
  if (rel) return nowMs - Number(rel[1]) * UNIT_MS[rel[2]!.toLowerCase()]!
  return Date.parse(raw)
}

const activityMs = (r: Row, nowMs: number): number => {
  const ms = Date.parse(String(r.lastActivityAt ?? r.startedAt ?? ""))
  return Number.isNaN(ms) ? nowMs : ms
}

export function emulateSessionList(all: readonly Row[], inputs: Record<string, unknown>, nowMs = Date.now()): Record<string, unknown> {
  let rows = all.filter(r => r.archived !== true || inputs.includeArchived === true)
  if (typeof inputs.status === "string") rows = rows.filter(r => r.status === inputs.status)
  else if (inputs.onlyAlive === true) rows = rows.filter(r => r.status === "running" || r.status === "starting")
  if (typeof inputs.q === "string" && inputs.q.trim()) {
    const needle = inputs.q.trim().toLowerCase()
    rows = rows.filter(r => ["id", "name", "label", "title", "cwd"].some(k => String(r[k] ?? "").toLowerCase().includes(needle)))
  }
  if (typeof inputs.updatedSince === "string") {
    const since = boundMs(inputs.updatedSince, nowMs)
    rows = rows.filter(r => activityMs(r, nowMs) >= since)
  }
  rows = [...rows].sort((a, b) => activityMs(b, nowMs) - activityMs(a, nowMs))
  const fields = Array.isArray(inputs.fields) ? (inputs.fields as string[]) : undefined
  const render = (list: readonly Row[]): Row[] =>
    fields ? list.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => fields.includes(k)))) : [...list]
  if (inputs.limit === undefined && inputs.cursor === undefined) return { sessions: render(rows), total: rows.length }
  const limit = Math.min(Number(inputs.limit ?? 50), 200)
  const start = typeof inputs.cursor === "string" ? Number(Buffer.from(inputs.cursor, "base64").toString("utf8")) : 0
  const page = rows.slice(start, start + limit)
  const next = start + limit
  return {
    items: render(page),
    ...(next < rows.length ? { nextCursor: Buffer.from(String(next)).toString("base64") } : {}),
    total: rows.length,
  }
}
