/**
 * The steward's `session_list` reader must never mistake the MCP contract
 * layer's over-cap marker for an empty page. Regression: `limit: 200` × 32
 * fields serialized to ~256 KB, came back as
 * `{truncated:true,totalBytes,hint}`, and `pageOf` returned null — so the scan
 * saw 0-2 of 538 terminal sessions and proposed no archive.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseWorkflowManifest } from "@agentproto/workflow/manifest"

const LIVE_LIST_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "apps",
  "session-steward",
  ".agentproto",
  "workflows",
  "session-steward",
  "live-list.mjs",
)

const marker = { truncated: true, totalBytes: 256_692, hint: "use limit/cursor/fields" }

const WORKFLOWS_DIR = join(dirname(LIVE_LIST_PATH), "..")
const MANIFESTS = ["session-steward", "session-steward-classify"].map(slug =>
  join(WORKFLOWS_DIR, slug, "WORKFLOW.md"),
)

let liveList: {
  scannedRows: (steps: Record<string, unknown>) => { sessions: unknown[]; truncated: boolean }
  pagedRows: (steps: Record<string, unknown>, id: string) => { rows: unknown[]; truncated: boolean }
  LIST_PAGE_LIMIT: number
  LIST_EXTRA_PAGES: number
}
const beforeAllLoad = async () => {
  liveList = (await import(LIVE_LIST_PATH)) as never
}

describe("session-steward live-list pagination", () => {
  it("throws on a truncated first page instead of returning zero rows", async () => {
    await beforeAllLoad()
    expect(() => liveList.scannedRows({ liveSessions: marker, endedSessions: marker })).toThrow(
      /truncated by the MCP result cap/,
    )
  })

  it("throws when a later map-collected page is a truncation marker", async () => {
    await beforeAllLoad()
    const steps = {
      liveSessions: { items: [], total: 0 },
      endedSessions: { items: [{ id: "s1" }], nextCursor: "abc", total: 2 },
      endedSessionsPage2: { results: [{ value: marker }] },
    }
    expect(() => liveList.scannedRows(steps)).toThrow(/truncated by the MCP result cap/)
  })

  it("still reads a normal multi-page response", async () => {
    await beforeAllLoad()
    const steps = {
      liveSessions: { items: [{ id: "live1" }], total: 1 },
      endedSessions: { items: [{ id: "s1" }], nextCursor: "abc", total: 2 },
      endedSessionsPage2: { results: [{ value: { items: [{ id: "s2" }], total: 2 } }] },
    }
    const out = liveList.scannedRows(steps)
    expect(out.sessions.map(s => (s as { id: string }).id)).toEqual(["live1", "s1", "s2"])
    expect(out.truncated).toBe(false)
  })

  it("keeps both WORKFLOW.md manifests' page count and limit in sync with the constants", async () => {
    await beforeAllLoad()
    type Node = { id?: string; inputs?: { limit?: number }; steps?: Node[] }
    const flatten = (steps: readonly Node[] | undefined, acc: Node[] = []): Node[] => {
      for (const step of steps ?? []) {
        acc.push(step)
        flatten(step.steps, acc)
      }
      return acc
    }
    for (const path of MANIFESTS) {
      const fm = parseWorkflowManifest(readFileSync(path, "utf8")).frontmatter as { steps?: Node[] }
      const rows = flatten(fm.steps).filter(s => /^(liveSessions|endedSessions)(Page\d+)?$/.test(s.id ?? ""))
      // Page 1 is the tool step itself; pages 2..N are map steps whose fetch
      // carries the limit. Two queries: live + ended.
      const perQuery = liveList.LIST_EXTRA_PAGES + 1
      expect(rows).toHaveLength(perQuery * 2)
      for (const step of rows) {
        const limit = step.inputs?.limit ?? step.steps?.[0]?.inputs?.limit
        expect(limit).toBe(liveList.LIST_PAGE_LIMIT)
      }
    }
  })
})
