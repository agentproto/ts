/**
 * Transcript search + read over a session LINEAGE, the read side of
 * conversation resumption.
 *
 * The contract:
 *   - the chain is walked from a session through its restart
 *     (`resumedFrom`), continue-fresh (`continuedFrom`) and handover
 *     (`succeeds`) links, cycle-safe and deduplicated
 *   - a search returns DATED EXCERPTS, bounded per excerpt and in total
 *   - a read never returns a whole transcript
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  buildTranscriptChain,
  clampExcerptChars,
  clampMaxResults,
  clampTotalChars,
  excerptAround,
  predecessorLinks,
  readTranscriptFile,
  searchTranscriptFile,
  TRANSCRIPT_EXCERPT_MAX_CHARS,
  TRANSCRIPT_SEARCH_MAX_RESULTS,
} from "../transcript-search.js"

describe("buildTranscriptChain", () => {
  const rows: Record<string, { id: string; resumedFrom?: string; continuedFrom?: string; succeeds?: string }> = {
    sess_new: { id: "sess_new", resumedFrom: "sess_old" },
    sess_old: { id: "sess_old", continuedFrom: "sess_base" },
    sess_base: { id: "sess_base" },
  }
  const lookup = (id: string) => rows[id]

  it("walks the restart and continue-fresh lineage back to the base session", () => {
    const chain = buildTranscriptChain("sess_new", lookup)
    expect(chain.map(c => c.sessionId)).toEqual(["sess_new", "sess_old", "sess_base"])
    expect(chain[0]?.via).toBeUndefined()
    expect(chain[1]?.via).toBe("resumedFrom")
    expect(chain[2]?.via).toBe("continuedFrom")
    expect(chain.map(c => c.depth)).toEqual([0, 1, 2])
  })

  it("follows the `succeeds` handover link", () => {
    const chain = buildTranscriptChain("sess_takeover", id =>
      id === "sess_takeover" ? { id, succeeds: "sess_predecessor" } : undefined,
    )
    expect(chain.map(c => c.sessionId)).toEqual(["sess_takeover", "sess_predecessor"])
    expect(chain[1]?.via).toBe("succeeds")
  })

  it("terminates on a cyclic lineage", () => {
    const cyclic: Record<string, { id: string; resumedFrom?: string }> = {
      a: { id: "a", resumedFrom: "b" },
      b: { id: "b", resumedFrom: "a" },
    }
    const chain = buildTranscriptChain("a", id => cyclic[id])
    expect(chain.map(c => c.sessionId)).toEqual(["a", "b"])
  })

  it("keeps a forgotten predecessor as a leaf (its transcript may still be on disk)", () => {
    const chain = buildTranscriptChain(
      "sess_new",
      id => (id === "sess_new" ? { id, resumedFrom: "gone" } : undefined),
    )
    // The descriptor is gone, so nothing is walked BEYOND it, but the id
    // stays in the chain: its events.jsonl may still exist on disk.
    expect(chain.map(c => c.sessionId)).toEqual(["sess_new", "gone"])
    expect(chain[1]?.via).toBe("resumedFrom")
  })

  it("lists the predecessor links of one session", () => {
    expect(
      predecessorLinks({ id: "x", resumedFrom: "a", continuedFrom: "b", succeeds: "c" }),
    ).toEqual([
      { via: "resumedFrom", id: "a" },
      { via: "continuedFrom", id: "b" },
      { via: "succeeds", id: "c" },
    ])
  })
})

describe("excerptAround", () => {
  it("keeps the match in the middle of a bounded excerpt", () => {
    const text = "x".repeat(500) + "NEEDLE" + "y".repeat(500)
    const { excerpt, matchStart } = excerptAround(text, "needle", 100)
    expect(excerpt.length).toBeLessThanOrEqual(102)
    expect(excerpt).toContain("NEEDLE")
    expect(matchStart).toBeGreaterThan(0)
  })

  it("returns the whole text when it already fits", () => {
    const { excerpt } = excerptAround("short needle", "needle", 600)
    expect(excerpt).toBe("short needle")
  })
})

describe("clamps", () => {
  it("bounds the result count, the excerpt size and the total", () => {
    expect(clampMaxResults(undefined)).toBe(10)
    expect(clampMaxResults(1000)).toBe(TRANSCRIPT_SEARCH_MAX_RESULTS)
    expect(clampExcerptChars(999_999)).toBe(TRANSCRIPT_EXCERPT_MAX_CHARS)
    expect(clampTotalChars(999_999)).toBe(100_000)
  })
})

describe("search + read over a transcript file", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "transcript-search-"))
    mkdirSync(join(tmp, "sess_old"), { recursive: true })
    const lines: string[] = []
    lines.push(JSON.stringify({ seq: 1, ts: "2026-01-01T00:00:00.000Z", kind: "user-prompt", text: "the mission is to ship the parser" }))
    lines.push(JSON.stringify({ seq: 2, ts: "2026-01-01T00:00:01.000Z", kind: "text-delta", text: "working on the parser now" }))
    lines.push(JSON.stringify({ seq: 3, ts: "2026-01-01T00:00:02.000Z", kind: "notice", text: "unrelated" }))
    // A big record: an excerpt must never be the whole thing.
    lines.push(
      JSON.stringify({
        seq: 4,
        ts: "2026-01-01T00:00:03.000Z",
        kind: "text-delta",
        text: `parser ${"filler ".repeat(2000)} parser`,
      }),
    )
    writeFileSync(join(tmp, "sess_old", "events.jsonl"), lines.join("\n") + "\n")
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  const path = () => join(tmp, "sess_old", "events.jsonl")

  it("finds the hits and dates them", async () => {
    const { hits } = await searchTranscriptFile(path(), "sess_old", { query: "parser" })
    expect(hits.length).toBe(3)
    expect(hits[0]?.ts).toBe("2026-01-01T00:00:00.000Z")
    expect(hits[0]?.kind).toBe("user-prompt")
    expect(hits[0]?.sessionId).toBe("sess_old")
  })

  it("never returns a whole record as an excerpt", async () => {
    const { hits } = await searchTranscriptFile(path(), "sess_old", { query: "parser", excerptChars: 200 })
    const big = hits.find(h => h.textLength > 1000)!
    expect(big).toBeDefined()
    expect(big.excerpt.length).toBeLessThanOrEqual(202)
    expect(big.textLength).toBeGreaterThan(big.excerpt.length)
  })

  it("bounds the number of hits", async () => {
    const { hits, truncated } = await searchTranscriptFile(path(), "sess_old", {
      query: "parser",
      maxResults: 1,
    })
    expect(hits.length).toBe(1)
    expect(truncated).toBe(true)
  })

  it("reads bounded excerpts, never the whole transcript", async () => {
    const { excerpts, truncated } = await readTranscriptFile(path(), "sess_old", {
      maxRecords: 2,
    })
    expect(excerpts.length).toBe(2)
    expect(excerpts[0]?.ts).toBe("2026-01-01T00:00:00.000Z")
    expect(truncated).toBe(true)
  })

  it("filters a read by query", async () => {
    const { excerpts } = await readTranscriptFile(path(), "sess_old", { query: "unrelated" })
    expect(excerpts.length).toBe(1)
    expect(excerpts[0]?.kind).toBe("notice")
  })

  it("returns nothing for a missing transcript instead of throwing", async () => {
    const { hits } = await searchTranscriptFile(join(tmp, "nope", "events.jsonl"), "nope", {
      query: "parser",
    })
    expect(hits).toEqual([])
  })
})
