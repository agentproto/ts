import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readSessionEventsSince } from "../app-pull-tools.js"

describe("readSessionEventsSince", () => {
  let tmp: string
  let filePath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "app-pull-tools-"))
    filePath = join(tmp, "events.jsonl")
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("filters by the since cursor and reports nextSeq as the max returned seq", () => {
    writeFileSync(
      filePath,
      [
        JSON.stringify({ seq: 1, ts: "t1", kind: "text-delta", text: "a" }),
        JSON.stringify({ seq: 2, ts: "t2", kind: "text-delta", text: "b" }),
        JSON.stringify({ seq: 3, ts: "t3", kind: "turn-end", reason: "done" }),
      ].join("\n") + "\n",
    )

    const result = readSessionEventsSince(filePath, 1, 500)
    expect(result.noTranscript).toBe(false)
    expect(result.events.map(e => e.seq)).toEqual([2, 3])
    expect(result.nextSeq).toBe(3)
  })

  it("returns nextSeq === since when no events pass the cursor", () => {
    writeFileSync(
      filePath,
      JSON.stringify({ seq: 1, ts: "t1", kind: "text-delta", text: "a" }) + "\n",
    )

    const result = readSessionEventsSince(filePath, 5, 500)
    expect(result.events).toEqual([])
    expect(result.nextSeq).toBe(5)
  })

  it("caps the returned events at limit", () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ seq: i + 1, ts: `t${i + 1}`, kind: "text-delta", text: String(i) }),
    )
    writeFileSync(filePath, lines.join("\n") + "\n")

    const result = readSessionEventsSince(filePath, 0, 3)
    expect(result.events.map(e => e.seq)).toEqual([1, 2, 3])
    expect(result.nextSeq).toBe(3)
  })

  it("skips blank and malformed lines", () => {
    writeFileSync(
      filePath,
      [
        JSON.stringify({ seq: 1, ts: "t1", kind: "text-delta", text: "a" }),
        "",
        "   ",
        "{not valid json",
        JSON.stringify({ seq: 2, ts: "t2", kind: "text-delta", text: "b" }),
      ].join("\n") + "\n",
    )

    const result = readSessionEventsSince(filePath, 0, 500)
    expect(result.events.map(e => e.seq)).toEqual([1, 2])
    expect(result.nextSeq).toBe(2)
  })

  it("returns an empty noTranscript result on ENOENT", () => {
    const missingPath = join(tmp, "does-not-exist.jsonl")
    const result = readSessionEventsSince(missingPath, 0, 500)
    expect(result).toEqual({ events: [], nextSeq: 0, noTranscript: true })
  })
})
