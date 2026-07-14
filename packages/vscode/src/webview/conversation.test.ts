import { describe, expect, it } from "vitest"

import {
  CONVERSATION_SCHEMA_VERSION,
  presentConversation,
  reduceConversation,
  type PresentedTextSegment,
  type PresentedToolSegment,
} from "./conversation.js"
import type { SessionEventRecord } from "../client/types.js"

let seq = 0
function rec(over: Partial<SessionEventRecord> & { kind: string }): SessionEventRecord {
  return { seq: ++seq, ts: `2026-01-01T00:00:0${seq % 10}.000Z`, ...over }
}

function freshSeq(): void {
  seq = 0
}

describe("reduceConversation", () => {
  it("stamps the schema version and session id", () => {
    freshSeq()
    const conv = reduceConversation("s1", [])
    expect(conv.version).toBe(CONVERSATION_SCHEMA_VERSION)
    expect(conv.sessionId).toBe("s1")
    expect(conv.turns).toEqual([])
    expect(conv.cursor).toBe(0)
  })

  it("opens a user turn per prompt and batches assistant activity into one turn", () => {
    freshSeq()
    const conv = reduceConversation("s1", [
      rec({ kind: "user-prompt", text: "hello" }),
      rec({ kind: "text-delta", text: "Hi " }),
      rec({ kind: "text-delta", text: "there\n" }),
      rec({ kind: "turn-end", reason: "completed" }),
    ])
    expect(conv.turns.map(t => t.role)).toEqual(["user", "assistant"])
    expect(conv.turns[0]!.segments).toHaveLength(1)
    expect(conv.turns[0]!.segments[0]).toMatchObject({ kind: "user", text: "hello" })
    // Consecutive text-deltas coalesce into ONE assistant-text segment.
    expect(conv.turns[1]!.segments).toHaveLength(1)
    expect(conv.turns[1]!.segments[0]).toMatchObject({
      kind: "assistant-text",
      text: "Hi there\n",
    })
  })

  it("keeps reasoning, text, and tool segments in emission order", () => {
    freshSeq()
    const conv = reduceConversation("s1", [
      rec({ kind: "user-prompt", text: "go" }),
      rec({ kind: "thought", text: "let me think\n" }),
      rec({ kind: "text-delta", text: "Running a command\n" }),
      rec({ kind: "tool-call", toolCallId: "t1", toolName: "bash", arguments: { command: "ls" } }),
      rec({ kind: "tool-result", toolCallId: "t1", result: "file.txt", isError: false }),
      rec({ kind: "text-delta", text: "Done\n" }),
      rec({ kind: "turn-end", reason: "completed" }),
    ])
    const asst = conv.turns[1]!
    // reasoning → assistant-text → tool → assistant-text (text after the tool
    // is a NEW segment, not merged back into the pre-tool one).
    expect(asst.segments.map(s => s.kind)).toEqual([
      "reasoning",
      "assistant-text",
      "tool",
      "assistant-text",
    ])
    const tool = asst.segments[2]
    expect(tool).toMatchObject({
      kind: "tool",
      toolName: "bash",
      status: "ok",
      isError: false,
      result: "file.txt",
    })
    expect((asst.segments[3] as { text: string }).text).toBe("Done\n")
  })

  it("correlates a tool-result with its earlier tool-call by toolCallId", () => {
    freshSeq()
    const conv = reduceConversation("s1", [
      rec({ kind: "tool-call", toolCallId: "abc", toolName: "read" }),
      rec({ kind: "tool-result", toolCallId: "abc", result: "contents", isError: false }),
    ])
    const tools = conv.turns[0]!.segments.filter(s => s.kind === "tool")
    // One card — the result folded into the call, not a second segment.
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ status: "ok", result: "contents", toolName: "read" })
  })

  it("marks a failed tool-result as error status", () => {
    freshSeq()
    const conv = reduceConversation("s1", [
      rec({ kind: "tool-call", toolCallId: "t1", toolName: "bash" }),
      rec({ kind: "tool-result", toolCallId: "t1", result: "boom", isError: true }),
    ])
    expect(conv.turns[0]!.segments[0]).toMatchObject({ status: "error", isError: true })
  })

  it("starts a fresh assistant turn after turn-end", () => {
    freshSeq()
    const conv = reduceConversation("s1", [
      rec({ kind: "text-delta", text: "first\n" }),
      rec({ kind: "turn-end", reason: "completed" }),
      rec({ kind: "text-delta", text: "second\n" }),
    ])
    expect(conv.turns).toHaveLength(2)
    expect(conv.turns.every(t => t.role === "assistant")).toBe(true)
    expect(conv.turns[0]!.id).not.toBe(conv.turns[1]!.id)
  })

  it("collapses streamed plan updates into one segment with the latest entries", () => {
    freshSeq()
    const conv = reduceConversation("s1", [
      rec({ kind: "user-prompt", text: "plan it" }),
      rec({
        kind: "plan",
        entries: [{ content: "step 1", priority: "high", status: "pending" }],
      }),
      rec({
        kind: "plan",
        entries: [
          { content: "step 1", priority: "high", status: "completed" },
          { content: "step 2", priority: "medium", status: "pending" },
        ],
      }),
    ])
    const plans = conv.turns[1]!.segments.filter(s => s.kind === "plan")
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ done: 1, total: 2 })
  })

  it("folds usage_update and usage_snapshot into merged conversation metadata", () => {
    freshSeq()
    const conv = reduceConversation("s1", [
      rec({ kind: "usage_update", size: 100_000, used: 4_200, cost: { amount: 0.1, currency: "USD" } }),
      rec({ kind: "usage_snapshot", tokensIn: 500, tokensOut: 250, contextUsed: 4_200, source: "adapter" }),
    ])
    expect(conv.usage).toMatchObject({
      size: 100_000,
      used: 4_200,
      cost: { amount: 0.1, currency: "USD" },
      tokensIn: 500,
      tokensOut: 250,
      contextUsed: 4_200,
      source: "adapter",
    })
    // usage is metadata, not an inline segment.
    expect(conv.turns).toHaveLength(0)
  })

  it("captures an agent question and an error as segments", () => {
    freshSeq()
    const conv = reduceConversation("s1", [
      rec({ kind: "agent-prompt", toolCallId: "p1", options: [{ optionId: "a", name: "Allow" }, "Deny"] }),
      rec({ kind: "error", error: { message: "kaput" } }),
    ])
    const kinds = conv.turns[0]!.segments.map(s => s.kind)
    expect(kinds).toEqual(["agent-question", "error"])
    expect(conv.turns[0]!.segments[0]).toMatchObject({ options: ["Allow", "Deny"] })
    expect(conv.turns[0]!.segments[1]).toMatchObject({ message: "kaput" })
  })

  // ── Idempotency / incremental replay ──────────────────────────────────

  it("is idempotent: duplicate and out-of-order seqs never duplicate segments", () => {
    freshSeq()
    const records: SessionEventRecord[] = [
      rec({ kind: "user-prompt", text: "hi" }),
      rec({ kind: "text-delta", text: "Hello\n" }),
      rec({ kind: "turn-end", reason: "completed" }),
    ]
    // A poll window that re-delivers the whole set plus a shuffled duplicate.
    const withDupes = [records[2]!, records[0]!, records[1]!, ...records]
    const conv = reduceConversation("s1", withDupes)
    expect(conv.turns.map(t => t.role)).toEqual(["user", "assistant"])
    expect(conv.turns[0]!.segments).toHaveLength(1)
    expect(conv.turns[1]!.segments).toHaveLength(1)
    expect((conv.turns[1]!.segments[0] as { text: string }).text).toBe("Hello\n")
  })

  it("re-reducing a superset appends the tail and keeps stable ids for the prefix", () => {
    freshSeq()
    const first: SessionEventRecord[] = [
      rec({ kind: "user-prompt", text: "hi" }),
      rec({ kind: "text-delta", text: "Hel" }),
    ]
    const convA = reduceConversation("s1", first)
    const idsA = convA.turns.flatMap(t => [t.id, ...t.segments.map(s => s.id)])

    // Live poll delivers more of the same assistant text plus a tool call.
    const more: SessionEventRecord[] = [
      ...first,
      rec({ kind: "text-delta", text: "lo\n" }),
      rec({ kind: "tool-call", toolCallId: "t9", toolName: "bash" }),
    ]
    const convB = reduceConversation("s1", more)

    // Same prefix ids survive (stable identity for expand/scroll preservation).
    const idsB = convB.turns.flatMap(t => [t.id, ...t.segments.map(s => s.id)])
    for (const id of idsA) expect(idsB).toContain(id)

    // The additional "lo\n" merged into the SAME assistant-text segment.
    const asst = convB.turns.find(t => t.role === "assistant")!
    const textSeg = asst.segments.find(s => s.kind === "assistant-text") as { text: string; id: string }
    expect(textSeg.text).toBe("Hello\n")
    expect(textSeg.id).toBe(
      (convA.turns[1]!.segments[0] as { id: string }).id,
    )
    // The new tool call appended as its own segment.
    expect(asst.segments.some(s => s.kind === "tool")).toBe(true)
    expect(convB.cursor).toBeGreaterThan(convA.cursor)
  })
})

/**
 * Provider-family acceptance matrix.
 *
 * The architectural invariant under test: EVERY adapter normalizes its
 * provider-native reasoning stream to the SAME `SessionEventRecord` `thought`
 * kind at the adapter/protocol boundary, BEFORE anything is written to
 * events.jsonl. The reducer therefore has NO per-provider branch — these
 * fixtures are byte-identical in shape by design (that identity IS the
 * acceptance criterion), differing only in the comment naming the upstream
 * origin. No live credentials; no provider parsing in the webview.
 */
describe("provider-family reasoning normalization → one collapsed segment", () => {
  /** A normalized reasoning turn: three `thought` chunks (as an adapter would
   *  emit after mapping its native stream) followed by assistant text. */
  function normalizedReasoningTurn(): SessionEventRecord[] {
    freshSeq()
    return [
      rec({ kind: "user-prompt", text: "solve it" }),
      rec({ kind: "thought", text: "First, " }),
      rec({ kind: "thought", text: "weigh the options.\n" }),
      rec({ kind: "thought", text: "Then decide.\n" }),
      rec({ kind: "text-delta", text: "Here is the answer.\n" }),
      rec({ kind: "turn-end", reason: "completed" }),
    ]
  }

  // Each family maps its native reasoning stream to the identical normalized
  // `thought` fixture above. Kimi/Moonshot is called out explicitly as the
  // SAME Claude-compatible contract (Kimi behind Claude-wire transport is a
  // Claude-wire mapper, not a Kimi UI serializer).
  const families: Array<{ family: string; origin: string }> = [
    { family: "Claude SDK / Anthropic-compatible", origin: "anthropic `thinking` delta → thought" },
    {
      family: "Kimi / Moonshot (Claude-compatible transport)",
      origin: "SAME Claude-wire fixture contract — Kimi behind Claude transport is a Claude-wire mapper, not a Kimi UI serializer",
    },
    { family: "ACP agent_thought_chunk", origin: "ACP `agent_thought_chunk` normalized to thought" },
    { family: "Pi thought stream", origin: "Pi reasoning delta → thought" },
  ]

  it.each(families)(
    "$family: multiple thought chunks collapse into ONE reasoning segment",
    ({ origin }) => {
      // `origin` documents the upstream mapping the adapter performed; the
      // reducer only ever sees the normalized `thought` records.
      expect(typeof origin).toBe("string")
      const conv = reduceConversation("s1", normalizedReasoningTurn())
      const assistant = conv.turns.find(t => t.role === "assistant")!
      const reasoning = assistant.segments.filter(s => s.kind === "reasoning")
      // One collapsed card — NOT one card/line per chunk.
      expect(reasoning).toHaveLength(1)
      expect((reasoning[0] as { text: string }).text).toBe(
        "First, weigh the options.\nThen decide.\n",
      )
      // Reasoning precedes the single assistant-text segment.
      expect(assistant.segments.map(s => s.kind)).toEqual(["reasoning", "assistant-text"])
    },
  )

  it("Mastra / no-thought stream produces NO reasoning segment", () => {
    freshSeq()
    const conv = reduceConversation("s1", [
      rec({ kind: "user-prompt", text: "hi" }),
      rec({ kind: "text-delta", text: "Hello\n" }),
      rec({ kind: "turn-end", reason: "completed" }),
    ])
    const assistant = conv.turns.find(t => t.role === "assistant")!
    expect(assistant.segments.some(s => s.kind === "reasoning")).toBe(false)
    expect(assistant.segments.map(s => s.kind)).toEqual(["assistant-text"])
  })

  it("interleaved reasoning + text + tool boundary yields no duplicate cards", () => {
    freshSeq()
    const conv = reduceConversation("s1", [
      rec({ kind: "user-prompt", text: "go" }),
      rec({ kind: "thought", text: "plan " }),
      rec({ kind: "thought", text: "it\n" }),
      rec({ kind: "text-delta", text: "Running.\n" }),
      rec({ kind: "tool-call", toolCallId: "t1", toolName: "bash", arguments: { c: "ls" } }),
      rec({ kind: "tool-result", toolCallId: "t1", result: "ok", isError: false }),
      rec({ kind: "text-delta", text: "Done.\n" }),
      rec({ kind: "turn-end", reason: "completed" }),
    ])
    const a = conv.turns.find(t => t.role === "assistant")!
    // One reasoning card, text split by the tool boundary, one tool card.
    expect(a.segments.map(s => s.kind)).toEqual([
      "reasoning",
      "assistant-text",
      "tool",
      "assistant-text",
    ])
    expect(a.segments.filter(s => s.kind === "reasoning")).toHaveLength(1)
    expect(a.segments.filter(s => s.kind === "tool")).toHaveLength(1)
    expect((a.segments[0] as { text: string }).text).toBe("plan it\n")
  })

  it("hydration + reconnect continuation appends into the same cards (overlapping poll window, no duplicates)", () => {
    freshSeq()
    // Hydration window.
    const r1 = rec({ kind: "user-prompt", text: "go" })
    const r2 = rec({ kind: "thought", text: "think " })
    const r3 = rec({ kind: "thought", text: "some " })
    const r4 = rec({ kind: "tool-call", toolCallId: "t1", toolName: "read" })
    // Reconnect RE-DELIVERS the last two records (r3, r4) then continues.
    const r5 = rec({ kind: "tool-result", toolCallId: "t1", result: "data", isError: false })
    const r6 = rec({ kind: "thought", text: "and more.\n" })
    // The controller accumulates records across polls; the overlapping window
    // means r3/r4 arrive twice. reduceConversation is idempotent per seq.
    const accumulated = [r1, r2, r3, r4, /* reconnect overlap → */ r3, r4, r5, r6]
    const conv = reduceConversation("s1", accumulated)
    const a = conv.turns.find(t => t.role === "assistant")!

    // r2+r3 collapse into ONE reasoning card; r6 (after the tool boundary)
    // is a distinct trailing reasoning card. No duplicate from the overlap.
    const reasoning = a.segments.filter(s => s.kind === "reasoning")
    expect(reasoning).toHaveLength(2)
    expect((reasoning[0] as { text: string }).text).toBe("think some ") // r3 applied once
    expect((reasoning[1] as { text: string }).text).toBe("and more.\n")
    // Exactly ONE tool card despite r4 arriving twice; the re-delivered result
    // folds into the same card.
    const tools = a.segments.filter(s => s.kind === "tool")
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ status: "ok", result: "data" })
  })
})

describe("presentConversation", () => {
  const renderers = {
    // Stub renderers whose output makes escaping/markdown observable.
    renderMarkdown: (t: string) => `MD[${t}]`,
    escapeHtml: (t: string) => t.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  }

  it("renders text segments as markdown html and escapes tool payloads", () => {
    freshSeq()
    const conv = reduceConversation("s1", [
      rec({ kind: "user-prompt", text: "hello" }),
      rec({ kind: "text-delta", text: "world" }),
      rec({
        kind: "tool-call",
        toolCallId: "t1",
        toolName: "bash",
        arguments: { command: "echo <script>" },
      }),
      rec({ kind: "tool-result", toolCallId: "t1", result: "<b>done</b>", isError: false }),
    ])
    const presented = presentConversation(conv, renderers)
    const userSeg = presented.turns[0]!.segments[0] as PresentedTextSegment
    expect(userSeg.html).toBe("MD[hello]")

    const tool = presented.turns[1]!.segments.find(s => s.kind === "tool") as PresentedToolSegment
    // Raw < / > must be escaped — never inserted as live markup.
    expect(tool.argsText).toContain("&lt;script&gt;")
    expect(tool.resultText).toBe("&lt;b&gt;done&lt;/b&gt;")
    expect(tool.status).toBe("ok")
  })

  it("preserves segment ids and usage metadata through presentation", () => {
    freshSeq()
    const conv = reduceConversation("s1", [
      rec({ kind: "text-delta", text: "hi" }),
      rec({ kind: "usage_update", size: 10, used: 2 }),
    ])
    const presented = presentConversation(conv, renderers)
    expect(presented.turns[0]!.segments[0]!.id).toBe(conv.turns[0]!.segments[0]!.id)
    expect(presented.usage).toMatchObject({ size: 10, used: 2 })
  })
})
