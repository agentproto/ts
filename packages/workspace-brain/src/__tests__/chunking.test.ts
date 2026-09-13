/**
 * Tests for {@link chunkTurns} / {@link chunkUri} / {@link renderChunkMarkdown}
 * — the pure turn-bounded chunking primitives `ingest-pipeline.ts` builds on.
 */

import { describe, expect, it } from "vitest"
import type { ConversationTurn } from "@agentproto/corpus"
import { chunkTurns, chunkUri, renderChunkBody, renderChunkMarkdown } from "../chunking.js"

function turn(role: string, text: string): ConversationTurn {
  return { role, text }
}

describe("chunkTurns", () => {
  it("groups a small transcript into a single chunk", () => {
    const turns = [turn("user", "hi"), turn("assistant", "hello there")]
    const chunks = chunkTurns(turns, 3500)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.index).toBe(0)
    expect(chunks[0]!.turnStart).toBe(0)
    expect(chunks[0]!.turnEnd).toBe(1)
    expect(chunks[0]!.turns).toEqual(turns)
  })

  it("returns no chunks for an empty turn list", () => {
    expect(chunkTurns([], 3500)).toEqual([])
  })

  it("splits a large transcript into multiple chunks bounded by maxBytes", () => {
    // 10 turns of ~50 bytes each ("Assistant: turn-N filler filler filler")
    // with a tight 120-byte ceiling — several turns fit per chunk, but not all 10.
    const turns = Array.from({ length: 10 }, (_, i) =>
      turn("assistant", `turn-${i} filler filler filler`),
    )
    const chunks = chunkTurns(turns, 120)
    expect(chunks.length).toBeGreaterThan(1)

    // Turn boundaries are exhaustive and non-overlapping, in order.
    let cursor = 0
    for (const [i, chunk] of chunks.entries()) {
      expect(chunk.index).toBe(i)
      expect(chunk.turnStart).toBe(cursor)
      expect(chunk.turnEnd).toBe(cursor + chunk.turns.length - 1)
      cursor += chunk.turns.length
    }
    expect(cursor).toBe(turns.length)

    // No chunk (other than a lone oversized turn) exceeds the ceiling by much.
    for (const chunk of chunks) {
      if (chunk.turns.length > 1) {
        expect(Buffer.byteLength(renderChunkBody(chunk.turns), "utf8")).toBeLessThanOrEqual(120)
      }
    }
  })

  it("never splits inside a single oversized turn", () => {
    const bigText = "x".repeat(500)
    const turns = [turn("user", "short"), turn("assistant", bigText), turn("user", "short again")]
    const chunks = chunkTurns(turns, 50)
    // The oversized turn gets its own chunk rather than being cut in half.
    const bigChunk = chunks.find(c => c.turns.some(t => t.text === bigText))
    expect(bigChunk!.turns).toHaveLength(1)
    expect(bigChunk!.turns[0]!.text).toBe(bigText)
  })
})

describe("chunkUri", () => {
  it("keeps the bare session id for chunk 0 (backward-compat filename)", () => {
    expect(chunkUri("sess-abc123", 0)).toBe("sess-abc123")
  })

  it("suffixes subsequent chunk indices distinctly", () => {
    expect(chunkUri("sess-abc123", 1)).toBe("sess-abc123#1")
    expect(chunkUri("sess-abc123", 2)).toBe("sess-abc123#2")
    expect(chunkUri("sess-abc123", 1)).not.toBe(chunkUri("sess-abc123", 2))
  })
})

describe("renderChunkMarkdown", () => {
  it("writes frontmatter the files adapter's parser can read back", () => {
    const md = renderChunkMarkdown({
      title: "Fix auth",
      sessionId: "sess-abc123",
      chunkIndex: 1,
      chunkCount: 3,
      turnStart: 5,
      turnEnd: 9,
      sessionTurnCount: 12,
      body: "User: hi\n\nAssistant: hello",
    })
    expect(md).toContain("sessionId: sess-abc123")
    expect(md).toContain("chunkIndex: 1")
    expect(md).toContain("chunkCount: 3")
    expect(md).toContain("turnStart: 5")
    expect(md).toContain("turnEnd: 9")
    expect(md).toContain("turnCount: 12")
    expect(md).toContain("sourceKind: conversation")
    expect(md).toContain("User: hi")
    expect(md).toContain("Assistant: hello")
  })
})
