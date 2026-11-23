/**
 * `pageAll`: read EVERY row of a paged daemon list tool (`{ items,
 * nextCursor?, total }` under `limit`/`cursor`) through any `callTool`.
 *
 * An unpaged list call grows with the registry until it passes the daemon's
 * MCP result cap (`MCP_RESULT_MAX_BYTES`, 100 KB), where the whole payload is
 * replaced by a `{ truncated, totalBytes, hint }` marker. Lenient readers
 * (`r.items ?? []`) showed that as an empty list. This helper:
 *
 *  - always sends `limit` and walks `nextCursor` to the end;
 *  - re-requests a page that hits the cap from the same cursor with half the
 *    limit, down to one row;
 *  - THROWS (an Error named `McpResultTruncatedError`) when even one row is
 *    over the cap, and on any response it cannot read as a page, so a failed
 *    read is never mistaken for "no rows".
 *
 * It recognises the marker in every form a caller can see it: a resolved
 * marker object (older daemons sent it as a success), a thrown
 * `McpResultTruncatedError` (`@agentproto/app-client`, the panels' shared
 * `unwrapText`), or a thrown Error whose message carries the marker JSON
 * (the panel bridge's `callTool` throws the raw error text).
 *
 * Inline panel scripts embed it verbatim (`var pageAll =
 * ${pageAll.toString()}`), so it stays self-contained: no imports, no
 * module-scope references.
 */
export interface PageAllOptions {
  /** First page size (halved on a capped page). Default: `args.limit`, else 50. */
  limit?: number
  /** Key of a legacy unpaged wrapper (`{ [listKey]: rows }`) a daemon that
   *  ignores `limit` answers with; its rows are taken as the whole list. */
  listKey?: string
  /** Called with every page envelope, for fields beside the rows (`boardId`). */
  onPage?: (page: Record<string, unknown>) => void
  /** Safety stop on a cursor that never ends. Default 1000 pages. */
  maxPages?: number
}

export async function pageAll<T = unknown>(
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  tool: string,
  args?: Record<string, unknown>,
  opts?: PageAllOptions,
): Promise<T[]> {
  const base: Record<string, unknown> = args || {}
  const o: PageAllOptions = opts || {}
  const maxPages = o.maxPages || 1000
  let pageSize = o.limit || (typeof base.limit === "number" && base.limit > 0 ? base.limit : 50)

  function markerOf(v: unknown): { totalBytes: number } | null {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null
    const m = v as { truncated?: unknown; totalBytes?: unknown }
    return m.truncated === true && typeof m.totalBytes === "number" ? { totalBytes: m.totalBytes } : null
  }
  function errorMarkerOf(err: unknown): { totalBytes: number } | null {
    const e = (err || {}) as { name?: unknown; message?: unknown; totalBytes?: unknown }
    const message = typeof e.message === "string" ? e.message : String(err)
    const json = /\{"truncated":true[^{}]*\}/.exec(message)
    if (json) {
      try {
        const parsed = markerOf(JSON.parse(json[0]))
        if (parsed) return parsed
      } catch (_) {
        // not the marker after all
      }
    }
    if (e.name === "McpResultTruncatedError") {
      const bytes = /\((\d+) bytes\)/.exec(message)
      return { totalBytes: typeof e.totalBytes === "number" ? e.totalBytes : bytes ? Number(bytes[1]) : 0 }
    }
    return null
  }

  const rows: T[] = []
  let cursor: string | undefined
  let pages = 0
  while (pages < maxPages) {
    const pageArgs: Record<string, unknown> = Object.assign({}, base, { limit: pageSize })
    if (cursor) pageArgs.cursor = cursor
    let result: unknown
    let marker: { totalBytes: number } | null
    try {
      result = await call(tool, pageArgs)
      marker = markerOf(result)
    } catch (err) {
      marker = errorMarkerOf(err)
      if (!marker) throw err
    }
    if (marker) {
      if (pageSize > 1) {
        pageSize = Math.ceil(pageSize / 2)
        continue
      }
      const err = new Error(
        tool + " page was truncated by the daemon's MCP result cap (" + marker.totalBytes + " bytes) even for a single row",
      )
      err.name = "McpResultTruncatedError"
      throw Object.assign(err, { totalBytes: marker.totalBytes })
    }
    pages++
    // A daemon that ignores `limit` answers the whole list at once.
    if (Array.isArray(result)) return rows.concat(result as T[])
    const page = (result || {}) as Record<string, unknown>
    if (o.onPage && typeof result === "object" && result !== null) o.onPage(page)
    if (Array.isArray(page.items)) {
      for (const row of page.items as T[]) rows.push(row)
      if (typeof page.nextCursor !== "string" || !page.nextCursor) return rows
      cursor = page.nextCursor
      continue
    }
    if (o.listKey && Array.isArray(page[o.listKey])) return rows.concat(page[o.listKey] as T[])
    throw new Error(tool + " returned an unexpected page: " + String(JSON.stringify(result)).slice(0, 200))
  }
  throw new Error(tool + ": stopped after " + maxPages + " pages without reaching the end of the list")
}
