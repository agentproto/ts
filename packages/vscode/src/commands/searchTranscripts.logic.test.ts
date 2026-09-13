import { describe, expect, it } from "vitest"

import { hitsToQuickPickItems, trimSnippet } from "./searchTranscripts.logic.js"
import type { BrainQueryHit } from "../client/daemonClient.js"

describe("trimSnippet", () => {
  it("collapses embedded whitespace/newlines to single spaces", () => {
    expect(trimSnippet("line one\n  line two\n\nline three")).toBe("line one line two line three")
  })

  it("returns short snippets unchanged (after collapsing)", () => {
    expect(trimSnippet("short snippet")).toBe("short snippet")
  })

  it("truncates with an ellipsis at the default 200 chars", () => {
    const long = "x".repeat(250)
    const out = trimSnippet(long)
    expect(out.length).toBe(200)
    expect(out.endsWith("…")).toBe(true)
  })

  it("respects a custom maxLen", () => {
    const out = trimSnippet("abcdefghij", 5)
    expect(out).toBe("abcd…")
  })
})

describe("hitsToQuickPickItems", () => {
  const hits: BrainQueryHit[] = [
    {
      sourceId: "sess-abc123",
      workspace: "agentik-studio",
      sessionId: "sess-abc123",
      title: "Brain search design",
      score: 4.2,
      snippet: "…decided to use BM25 for the brain…",
    },
    {
      sourceId: "sess-noTitle",
      workspace: "default",
      sessionId: "sess-noTitle",
      score: 1,
      snippet: "no title here",
    },
    {
      sourceId: "sess-bare#1",
      workspace: "default",
      score: 0.5,
      snippet: "no sessionId either — a knowledge-file source",
    },
  ]

  it("label prefers title, falls back to sessionId, falls back to sourceId", () => {
    const items = hitsToQuickPickItems(hits)
    expect(items[0]?.label).toBe("Brain search design")
    expect(items[1]?.label).toBe("sess-noTitle")
    expect(items[2]?.label).toBe("sess-bare#1")
  })

  it("description is sessionId/sourceId, with workspace appended when it differs from the caller's", () => {
    const items = hitsToQuickPickItems(hits, "default")
    expect(items[0]?.description).toBe("sess-abc123 · agentik-studio")
    // Same workspace as caller — no redundant suffix.
    expect(items[1]?.description).toBe("sess-noTitle")
    expect(items[2]?.description).toBe("sess-bare#1")
  })

  it("description has no workspace suffix when callerWorkspace is unknown", () => {
    const items = hitsToQuickPickItems(hits)
    expect(items[0]?.description).toBe("sess-abc123")
  })

  it("detail is the trimmed snippet", () => {
    const items = hitsToQuickPickItems(hits)
    expect(items[0]?.detail).toBe("…decided to use BM25 for the brain…")
  })

  it("hitIndex round-trips to the original hits array position", () => {
    const items = hitsToQuickPickItems(hits)
    expect(items.map(i => i.hitIndex)).toEqual([0, 1, 2])
  })
})
