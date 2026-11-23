import { describe, expect, it } from "vitest"
import { McpToolError } from "../index.js"
import { pageAll } from "../page-all.js"

type Args = Record<string, unknown>
const marker = (totalBytes: number) => ({ truncated: true, totalBytes, hint: "use limit/cursor/fields" })

/** A paged list tool over `rows`; a page with more than `fits` rows is
 *  answered by `overCap(bytes)` (the daemon's result-cap marker). */
function pagedTool(rows: unknown[], fits: number, overCap: (bytes: number) => unknown) {
  const calls: Args[] = []
  const call = async (_tool: string, args: Args): Promise<unknown> => {
    calls.push(args)
    const limit = Number(args.limit)
    const start = typeof args.cursor === "string" ? Number(args.cursor) : 0
    if (limit > fits) return overCap(limit * 4_000)
    const end = start + limit
    return { items: rows.slice(start, end), total: rows.length, ...(end < rows.length ? { nextCursor: String(end) } : {}) }
  }
  return { call, calls }
}

const rows = Array.from({ length: 23 }, (_, i) => ({ id: i }))

describe("pageAll", () => {
  it("walks every page with limit/cursor", async () => {
    const { call, calls } = pagedTool(rows, 100, b => marker(b))
    await expect(pageAll(call, "x_list", { full: true }, { limit: 10 })).resolves.toEqual(rows)
    expect(calls).toEqual([
      { full: true, limit: 10 },
      { full: true, limit: 10, cursor: "10" },
      { full: true, limit: 10, cursor: "20" },
    ])
  })

  it("halves a page answered with a successful marker (older daemons)", async () => {
    const { call, calls } = pagedTool(rows, 6, b => marker(b))
    await expect(pageAll(call, "x_list", {}, { limit: 20 })).resolves.toEqual(rows)
    expect(calls.map(c => c.limit).slice(0, 3)).toEqual([20, 10, 5])
  })

  it("halves a page whose call threw McpResultTruncatedError or an error carrying the marker JSON", async () => {
    const typed = pagedTool(rows, 6, b => {
      const err = new McpToolError("x_list", "host", JSON.stringify(marker(b)))
      err.name = "McpResultTruncatedError"
      throw err
    })
    await expect(pageAll(typed.call, "x_list", {}, { limit: 20 })).resolves.toEqual(rows)
    // The panel bridge throws the raw error text.
    const raw = pagedTool(rows, 6, b => {
      throw new Error(JSON.stringify(marker(b)))
    })
    await expect(pageAll(raw.call, "x_list", {}, { limit: 20 })).resolves.toEqual(rows)
  })

  it("throws, never resolves a partial or empty list, when one row is over the cap", async () => {
    const { call } = pagedTool(rows, 0, b => marker(b))
    await expect(pageAll(call, "x_list")).rejects.toMatchObject({ name: "McpResultTruncatedError" })
  })

  it("rethrows any other failure and rejects an unreadable page", async () => {
    await expect(pageAll(async () => { throw new Error("boom") }, "x_list")).rejects.toThrow("boom")
    await expect(pageAll(async () => "unknown daemon tool: x_list", "x_list")).rejects.toThrow(/unexpected page/)
    await expect(pageAll(async () => ({ rows: [] }), "x_list")).rejects.toThrow(/unexpected page/)
  })

  it("takes a bare array or the legacy wrapper of a daemon that ignores limit", async () => {
    await expect(pageAll(async () => [1, 2], "x_list")).resolves.toEqual([1, 2])
    await expect(pageAll(async () => ({ tasks: [3] }), "task_list", {}, { listKey: "tasks" })).resolves.toEqual([3])
  })

  it("hands each page envelope to onPage", async () => {
    const seen: unknown[] = []
    await pageAll(async () => ({ items: [1], total: 1, boardId: "tree:s1" }), "task_list", {}, { onPage: p => seen.push(p.boardId) })
    expect(seen).toEqual(["tree:s1"])
  })

  it("survives toString() embedding (inline panels compile it on its own)", async () => {
    const embedded = new Function(`return ${pageAll.toString()}`)() as typeof pageAll
    const { call } = pagedTool(rows, 6, b => marker(b))
    await expect(embedded(call, "x_list", {}, { limit: 20 })).resolves.toEqual(rows)
  })
})
