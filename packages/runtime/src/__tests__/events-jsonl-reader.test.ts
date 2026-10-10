/**
 * Tests for the indexed `since`-cursor reader behind `GET /sessions/:id/events`
 * and `/events/stream` (events-jsonl-reader.ts): seek correctness against a
 * naive full parse, limit early-exit, incremental index extension on growth,
 * and invalidation on truncation / in-place rewrite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CHECKPOINT_EVERY,
  clearEventsIndexCache,
  eventsIndexSnapshot,
  fastSeq,
  openEventRecords,
  seekOffsetForSince,
} from "../events-jsonl-reader.js"

function line(seq: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ seq, ts: "2026-06-01T00:00:00.000Z", kind: "text-delta", text: `r${seq}`, ...extra })
}

function naive(path: string, since: number): number[] {
  const out: number[] = []
  for (const l of readFileSync(path, "utf8").split("\n")) {
    const t = l.trim()
    if (!t) continue
    try {
      const r = JSON.parse(t) as { seq?: unknown }
      if (typeof r.seq === "number" && r.seq > since) out.push(r.seq)
    } catch {
      // skipped, like the route
    }
  }
  return out
}

async function read(path: string, since: number, limit = Infinity): Promise<number[]> {
  const out: number[] = []
  for await (const rec of await openEventRecords(path, since)) {
    if (out.length >= limit) break
    out.push(rec.seq as number)
  }
  return out
}

describe("fastSeq", () => {
  const f = (s: string) => {
    const b = Buffer.from(s)
    return fastSeq(b, 0, b.length)
  }
  it("reads seq off the writer's prefix", () => {
    expect(f('{"seq":42,"ts":"x"}')).toBe(42)
    expect(f('{"seq":0,"ts":"x"}')).toBe(0)
    expect(f('{"seq":7}')).toBe(7)
  })
  it("declines anything it can't vouch for", () => {
    expect(f('{"ts":"x","seq":42}')).toBe(-1)
    expect(f('{ "seq":42}')).toBe(-1)
    expect(f('{"seq":"42"}')).toBe(-1)
    expect(f('{"seq":042,"a":1}')).toBe(-1)
    expect(f('{"seq":4.2,"a":1}')).toBe(-1)
    expect(f('{"seq":1234567890123456,"a":1}')).toBe(-1)
    expect(f("garbage")).toBe(-1)
  })
})

describe("openEventRecords", () => {
  let tmp: string
  let file: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "events-reader-"))
    file = join(tmp, "events.jsonl")
    clearEventsIndexCache()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(tmp, { recursive: true, force: true })
  })

  function writeSeqs(seqs: number[]): void {
    writeFileSync(file, seqs.map(s => line(s)).join("\n") + "\n")
  }

  it("matches a naive full parse for every cursor, seeking past earlier records", async () => {
    const n = CHECKPOINT_EVERY * 5 + 17
    const seqs = Array.from({ length: n }, (_, i) => i + 1)
    // Mix in lines the fast path can't read, plus garbage and blanks.
    const lines = seqs.map(s =>
      s % 97 === 0 ? JSON.stringify({ kind: "x", seq: s, ts: "t" }) : line(s),
    )
    lines.splice(300, 0, "not json {{{", "", '{"seq":12,"broken"')
    writeFileSync(file, lines.join("\n") + "\n")

    for (const since of [0, 1, 255, 256, 257, 700, 1024, n - 1, n, n + 50]) {
      expect(await read(file, since)).toEqual(naive(file, since))
    }
    // A cursor deep in the file starts reading well past byte 0.
    expect(await seekOffsetForSince(file, n - 1)).toBeGreaterThan(statSync(file).size / 2)
    expect(eventsIndexSnapshot(file)?.checkpoints).toBeGreaterThan(4)
  })

  it("stays correct with non-monotonic seqs (writer restart duplicates)", async () => {
    const seqs = [
      ...Array.from({ length: 600 }, (_, i) => i + 1),
      ...Array.from({ length: 600 }, (_, i) => i + 1),
      ...Array.from({ length: 50 }, (_, i) => i + 601),
    ]
    writeSeqs(seqs)
    for (const since of [0, 10, 300, 599, 600, 620]) {
      expect(await read(file, since)).toEqual(naive(file, since))
    }
  })

  it("does not JSON.parse records at/below the cursor and stops at the limit", async () => {
    const n = CHECKPOINT_EVERY * 8
    writeSeqs(Array.from({ length: n }, (_, i) => i + 1))
    await seekOffsetForSince(file, 1) // warm the index (its scan uses the fast path too)
    const parse = vi.spyOn(JSON, "parse")
    const got = await read(file, n - 600, 10)
    expect(got).toEqual(Array.from({ length: 10 }, (_, i) => n - 600 + i + 1))
    // limit + the one look-ahead record the consumer pulled before breaking —
    // not the ~600 records past the cursor, let alone the whole file.
    // (Filtered to transcript lines: the test runner's own RPC parses too.)
    const lineParses = parse.mock.calls.filter(
      ([arg]) => typeof arg === "string" && arg.startsWith('{"seq":'),
    )
    expect(lineParses).toHaveLength(11)
  })

  it("extends the index incrementally as the file grows", async () => {
    writeSeqs(Array.from({ length: 1000 }, (_, i) => i + 1))
    expect(await read(file, 990)).toEqual(Array.from({ length: 10 }, (_, i) => 991 + i))
    const before = eventsIndexSnapshot(file)!
    expect(before.indexedOffset).toBe(statSync(file).size)

    appendFileSync(file, Array.from({ length: 1000 }, (_, i) => line(1001 + i)).join("\n") + "\n")
    expect(await read(file, 1995)).toEqual([1996, 1997, 1998, 1999, 2000])
    const after = eventsIndexSnapshot(file)!
    expect(after.indexedOffset).toBe(statSync(file).size)
    expect(after.maxSeq).toBe(2000)
    expect(after.checkpoints).toBeGreaterThan(before.checkpoints)
    expect(await seekOffsetForSince(file, 1995)).toBeGreaterThan(before.indexedOffset)
  })

  it("picks up an unterminated trailing line and indexes it once completed", async () => {
    writeFileSync(file, `${line(1)}\n${line(2)}\n${line(3)}`)
    expect(await read(file, 1)).toEqual([2, 3])
    appendFileSync(file, `\n${line(4)}\n`)
    expect(await read(file, 2)).toEqual([3, 4])
  })

  it("invalidates on truncation", async () => {
    writeSeqs(Array.from({ length: 2000 }, (_, i) => i + 1))
    expect(await read(file, 1990)).toHaveLength(10)
    writeSeqs(Array.from({ length: 50 }, (_, i) => i + 1))
    expect(await read(file, 40)).toEqual(Array.from({ length: 10 }, (_, i) => 41 + i))
    expect(eventsIndexSnapshot(file)?.maxSeq).toBe(50)
  })

  it("invalidates on an in-place rewrite that leaves the file larger", async () => {
    writeSeqs(Array.from({ length: 1000 }, (_, i) => i + 1))
    expect(await read(file, 995)).toEqual([996, 997, 998, 999, 1000])
    // Same path, different content, bigger file: seqs re-numbered so the
    // stale checkpoints would seek to the wrong place.
    writeFileSync(
      file,
      Array.from({ length: 1500 }, (_, i) => line(i + 1, { text: `rewritten-${i}-xx` })).join("\n") + "\n",
    )
    expect(await read(file, 1490)).toEqual(naive(file, 1490))
    expect(await read(file, 500)).toEqual(naive(file, 500))
    expect(eventsIndexSnapshot(file)?.maxSeq).toBe(1500)
  })

  it("rejects with ENOENT for a missing file", async () => {
    await expect(openEventRecords(join(tmp, "nope.jsonl"), 0)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(openEventRecords(join(tmp, "nope.jsonl"), 5)).rejects.toMatchObject({ code: "ENOENT" })
  })
})
