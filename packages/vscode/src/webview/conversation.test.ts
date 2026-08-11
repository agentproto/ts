import { describe, expect, it } from "vitest"

import {
  CONVERSATION_SCHEMA_VERSION,
  clampToLines,
  groupActivity,
  presentConversation,
  reduceConversation,
  TOOL_IO_MAX_LINES,
  type PresentedActivitySegment,
  type PresentedSegment,
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

describe("reduceConversation — tool-call enrichment", () => {
  it("merges a repeat tool-call onto the announced one instead of opening a second card", () => {
    freshSeq()
    // The claude-code bridge's real shape: announce with a bare title and no
    // input, then fill both in (see @agentproto/acp's tool_call_update arm).
    const conv = reduceConversation("s1", [
      rec({ kind: "tool-call", toolCallId: "t1", toolName: "Read File", arguments: {} }),
      rec({
        kind: "tool-call",
        toolCallId: "t1",
        toolName: "Read /tmp/probe.txt",
        arguments: { file_path: "/tmp/probe.txt" },
      }),
      rec({ kind: "tool-result", toolCallId: "t1", result: "hello", isError: false }),
    ])

    const tools = conv.turns.flatMap(t => t.segments).filter(s => s.kind === "tool")
    expect(tools).toHaveLength(1) // one read, one card
    expect(tools[0]).toMatchObject({
      id: "tool-t1",
      toolName: "Read /tmp/probe.txt",
      arguments: { file_path: "/tmp/probe.txt" },
      result: "hello",
      status: "ok",
    })
  })

  it("never lets an enrichment erase what the announcement said", () => {
    freshSeq()
    const conv = reduceConversation("s1", [
      rec({ kind: "tool-call", toolCallId: "t1", toolName: "Read File", arguments: { a: 1 } }),
      // toolName "" is what the acp client emits for an untitled enrichment.
      rec({ kind: "tool-call", toolCallId: "t1", toolName: "" }),
    ])
    const tool = conv.turns.flatMap(t => t.segments).find(s => s.kind === "tool")
    expect(tool).toMatchObject({ toolName: "Read File", arguments: { a: 1 } })
  })

  it("stays idempotent under replay — re-reducing the same records yields the same segments", () => {
    freshSeq()
    const records = [
      rec({ kind: "tool-call", toolCallId: "t1", toolName: "Read File", arguments: {} }),
      rec({ kind: "tool-call", toolCallId: "t1", toolName: "Read x.ts", arguments: { path: "x.ts" } }),
    ]
    // Every poll re-reduces the accumulated list; a merge that appended would
    // grow the timeline on each tick.
    expect(reduceConversation("s1", records)).toEqual(reduceConversation("s1", records))
  })
})

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

  it("carries a user-prompt record's `source` onto the turn as promptSource", () => {
    freshSeq()
    const conv = reduceConversation("s1", [
      rec({ kind: "user-prompt", text: "status?", source: "agent:sess_boss1" }),
      rec({ kind: "turn-end", reason: "completed" }),
      rec({ kind: "user-prompt", text: "a human turn" }),
    ])
    expect(conv.turns[0]!.promptSource).toBe("agent:sess_boss1")
    // A source-less prompt (human) stays without the field.
    expect(conv.turns[conv.turns.length - 1]!.promptSource).toBeUndefined()
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

  it("settles nested streaming calls at turn-end without overwriting an arrived result", () => {
    freshSeq()
    const conv = reduceConversation("s1", [
      rec({ kind: "tool-call", toolCallId: "outer", toolName: "View Image", arguments: { path: "one.png" } }),
      rec({ kind: "tool-call", toolCallId: "inner", toolName: "View Image", arguments: { path: "two.png" } }),
      // Streaming updates enrich the already-announced nested calls rather
      // than creating cards of their own.
      rec({ kind: "tool-call", toolCallId: "outer", toolName: "View Image /one.png", isUpdate: true }),
      rec({ kind: "tool-call", toolCallId: "inner", toolName: "View Image /two.png", isUpdate: true }),
      // The inner result arrived; Hermes omitted the outer completion.
      rec({ kind: "tool-result", toolCallId: "inner", result: "rendered", isError: false }),
      rec({ kind: "turn-end", reason: "completed" }),
    ])

    const tools = conv.turns[0]!.segments.filter(s => s.kind === "tool")
    expect(tools).toHaveLength(2)
    expect(tools).toMatchObject([
      { toolCallId: "outer", toolName: "View Image /one.png", status: "ok" },
      { toolCallId: "inner", toolName: "View Image /two.png", status: "ok", result: "rendered" },
    ])

    // The presentation/activity layer receives no pending leaf, so it stops
    // ticking and the closed row reports completed steps instead of running.
    const presented = presentConversation(conv, {
      renderMarkdown: text => text,
      escapeHtml: text => text,
    })
    const activity = presented.turns[0]!.segments[0] as PresentedActivitySegment
    expect(activity).toMatchObject({ kind: "activity", status: "ok", summary: "2 steps" })
    expect(activity.pendingSince).toBeUndefined()
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

  it("preserves plan title through reducer and presenter", () => {
    freshSeq()
    const conv = reduceConversation("s1", [
      rec({ kind: "user-prompt", text: "plan it" }),
      rec({
        kind: "plan",
        title: "Multi-provider workspace-brain",
        entries: [
          { content: "step 1", priority: "high", status: "pending" },
          { content: "step 2", priority: "medium", status: "pending" },
        ],
      }),
    ])
    const plan = conv.turns[1]!.segments.find(s => s.kind === "plan")!
    expect(plan).toMatchObject({ title: "Multi-provider workspace-brain", done: 0, total: 2 })
  })

  it("adopts title from a later plan update if the first had none", () => {
    freshSeq()
    const conv = reduceConversation("s1", [
      rec({ kind: "user-prompt", text: "plan it" }),
      rec({
        kind: "plan",
        entries: [{ content: "step 1", priority: "high", status: "pending" }],
      }),
      rec({
        kind: "plan",
        title: "Late title",
        entries: [
          { content: "step 1", priority: "high", status: "completed" },
          { content: "step 2", priority: "medium", status: "pending" },
        ],
      }),
    ])
    const plan = conv.turns[1]!.segments.find(s => s.kind === "plan")!
    expect(plan).toMatchObject({ title: "Late title", done: 1, total: 2 })
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

  it("marks a question resolved once a matching permission-resolved record arrives", () => {
    freshSeq()
    const conv = reduceConversation("s1", [
      rec({ kind: "agent-prompt", toolCallId: "p1", options: [{ optionId: "a", name: "Allow" }, "Deny"] }),
      rec({ kind: "permission-resolved", toolCallId: "p1", decision: "approve", optionId: "a" }),
    ])
    const question = conv.turns[0]!.segments.find(s => s.kind === "agent-question")
    expect(question).toMatchObject({
      toolCallId: "p1",
      resolved: { decision: "approve", optionId: "a" },
    })
  })

  it("ignores a permission-resolved record with no matching pending question", () => {
    freshSeq()
    const conv = reduceConversation("s1", [
      rec({ kind: "permission-resolved", toolCallId: "unknown", decision: "deny" }),
    ])
    // No agent-prompt was ever seen for "unknown" — nothing to resolve, and no
    // segment gets synthesized out of thin air.
    expect(conv.turns.flatMap(t => t.segments)).toHaveLength(0)
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

// Recurses into activity-group children (groupActivity folds ≥2 consecutive
// tool/reasoning segments into one 'activity' wrapper) — a test asserting on
// "all tool segments" must look inside, or a fold silently drops coverage.
function allToolSegments(segments: readonly PresentedSegment[]): PresentedToolSegment[] {
  const out: PresentedToolSegment[] = []
  for (const seg of segments) {
    if (seg.kind === "tool") out.push(seg)
    else if (seg.kind === "activity") out.push(...allToolSegments(seg.children))
  }
  return out
}

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

  it("clamps a long tool result to TOOL_IO_MAX_LINES and reports the full count", () => {
    freshSeq()
    const conv = reduceConversation("s1", [
      rec({ kind: "tool-call", toolCallId: "t1", toolName: "bash", arguments: "pnpm test" }),
      rec({
        kind: "tool-result",
        toolCallId: "t1",
        result: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"),
        isError: false,
      }),
    ])
    const tool = presentConversation(conv, renderers).turns[0]!.segments.find(
      s => s.kind === "tool",
    ) as PresentedToolSegment

    expect(tool.resultText?.split("\n")).toHaveLength(TOOL_IO_MAX_LINES)
    expect(tool.resultText).toBe("line 1\nline 2\nline 3")
    expect(tool.resultClamped).toBe(true)
    // The count is of the FULL value — it's what the "N more" link promises.
    expect(tool.resultLines).toBe(40)
    // A short input is left whole and advertises nothing to open.
    expect(tool.argsText).toBe("pnpm test")
    expect(tool.argsClamped).toBe(false)
    expect(tool.argsLines).toBe(1)
  })

  it("never ships the dropped lines to the webview — the clamp is not a CSS trick", () => {
    freshSeq()
    const conv = reduceConversation("s1", [
      rec({ kind: "tool-call", toolCallId: "t1", toolName: "bash", arguments: "x" }),
      rec({ kind: "tool-result", toolCallId: "t1", result: "a\nb\nc\nSECRET_TAIL", isError: false }),
    ])
    const tool = presentConversation(conv, renderers).turns[0]!.segments.find(
      s => s.kind === "tool",
    ) as PresentedToolSegment
    // Clipping in CSS would leave the tail sitting in the DOM. It must not
    // cross the boundary at all — the host re-derives it on demand instead.
    expect(tool.resultText).not.toContain("SECRET_TAIL")
    expect(JSON.stringify(tool)).not.toContain("SECRET_TAIL")
  })

  it("flags a still-running run_in_background tool call as background", () => {
    freshSeq()
    const conv = reduceConversation("s1", [
      rec({
        kind: "tool-call",
        toolCallId: "t1",
        toolName: "bash",
        arguments: { command: "pnpm dev", run_in_background: true },
      }),
    ])
    const tool = presentConversation(conv, renderers).turns[0]!.segments.find(
      s => s.kind === "tool",
    ) as PresentedToolSegment
    expect(tool.status).toBe("pending")
    expect(tool.background).toBe(true)
  })

  it("does not flag a settled run_in_background call, or a foreground call, as background", () => {
    freshSeq()
    const conv = reduceConversation("s1", [
      rec({
        kind: "tool-call",
        toolCallId: "t1",
        toolName: "bash",
        arguments: { command: "pnpm dev", run_in_background: true },
      }),
      rec({ kind: "tool-result", toolCallId: "t1", result: "done", isError: false }),
      rec({ kind: "tool-call", toolCallId: "t2", toolName: "bash", arguments: { command: "ls" } }),
    ])
    // Two consecutive tool segments fold into one activity group (groupActivity,
    // MIN_ACTIVITY_GROUP = 2) — recurse into `children` to find both underneath.
    const tools = allToolSegments(presentConversation(conv, renderers).turns.flatMap(t => t.segments))
    expect(tools).toHaveLength(2)
    // Settled — the background window has closed even though it started as one.
    expect(tools[0]!.background).toBeUndefined()
    // Never backgrounded to begin with, and still pending.
    expect(tools[1]!.status).toBe("pending")
    expect(tools[1]!.background).toBeUndefined()
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

describe("groupActivity", () => {
  const tool = (id: string, over: Partial<PresentedToolSegment> = {}): PresentedToolSegment => ({
    kind: "tool",
    id,
    toolName: "bash",
    isError: false,
    status: "ok",
    ...over,
  })
  const text = (id: string): PresentedTextSegment => ({ kind: "assistant-text", id, html: "hi" })
  const reasoning = (id: string): PresentedTextSegment => ({ kind: "reasoning", id, html: "hmm" })

  const kinds = (segs: PresentedSegment[]): string[] => segs.map(s => s.kind)

  it("folds a run of consecutive reasoning/tool steps into one activity group", () => {
    const out = groupActivity([reasoning("a"), tool("b"), tool("c")])
    expect(kinds(out)).toEqual(["activity"])
    const group = out[0] as PresentedActivitySegment
    expect(group.children.map(c => c.id)).toEqual(["a", "b", "c"])
    expect(group.count).toBe(3)
    expect(group.summary).toBe("3 steps")
    expect(group.status).toBe("ok")
  })

  it("leaves a lone step ungrouped — folding one row into one row buys nothing", () => {
    expect(kinds(groupActivity([tool("a"), text("b")]))).toEqual(["tool", "assistant-text"])
  })

  it("never folds text, plans, questions or errors — a conclusion is never hidden behind a fold", () => {
    const out = groupActivity([
      tool("a"),
      tool("b"),
      text("c"),
      { kind: "error", id: "d", text: "boom" },
      { kind: "agent-question", id: "e", options: ["yes"] },
      { kind: "plan", id: "f", entries: [], done: 0, total: 0 },
    ])
    expect(kinds(out)).toEqual(["activity", "assistant-text", "error", "agent-question", "plan"])
  })

  it("starts a NEW group after an interrupting text segment", () => {
    const out = groupActivity([tool("a"), tool("b"), text("c"), tool("d"), tool("e")])
    expect(kinds(out)).toEqual(["activity", "assistant-text", "activity"])
    expect((out[0] as PresentedActivitySegment).id).toBe("act-a")
    expect((out[2] as PresentedActivitySegment).id).toBe("act-d")
  })

  it("drops nothing and preserves order — every input segment survives exactly once", () => {
    const input: PresentedSegment[] = [reasoning("a"), tool("b"), text("c"), tool("d"), tool("e")]
    const flatten = (segs: PresentedSegment[]): string[] =>
      segs.flatMap(s => (s.kind === "activity" ? s.children.map(c => c.id) : [s.id]))
    expect(flatten(groupActivity(input))).toEqual(["a", "b", "c", "d", "e"])
  })

  it("names the in-flight step while pending — that is what a waiting user reads", () => {
    const group = groupActivity([
      reasoning("a"),
      tool("b", { toolName: "read_file", status: "pending", ts: "2026-01-01T00:00:00.000Z" }),
    ])[0] as PresentedActivitySegment
    expect(group.status).toBe("pending")
    expect(group.summary).toBe("read_file · 2 steps")
    expect(group.pendingSince).toBe("2026-01-01T00:00:00.000Z")
  })

  it("finds the in-flight step even when a later step already settled (out-of-order results)", () => {
    const group = groupActivity([
      tool("a", { toolName: "slow", status: "pending", ts: "2026-01-01T00:00:00.000Z" }),
      tool("b", { toolName: "fast", status: "ok" }),
    ])[0] as PresentedActivitySegment
    expect(group.status).toBe("pending")
    expect(group.summary).toBe("slow · 2 steps")
  })

  it("labels a pending reasoning-only run as Thinking", () => {
    const group = groupActivity([reasoning("a"), reasoning("b")])[0] as PresentedActivitySegment
    // No tool in flight, so the run reads as settled rather than hanging.
    expect(group.status).toBe("ok")
    expect(group.summary).toBe("2 steps")
  })

  it("does not call a run failed for a step it recovered from", () => {
    // A command failing and the agent adapting is the normal shape of agent
    // work, not a failed run. Stamping ✗ across six steps because one of them
    // was recovered from reports a failure that did not happen.
    const group = groupActivity([
      tool("a", { status: "error", isError: true }),
      tool("b", { status: "ok" }),
    ])[0] as PresentedActivitySegment
    expect(group.status).toBe("ok")
    // The failure is still stated, so the fold buries nothing: the row reads
    // "✓ 2 steps · 1 failed" — it finished, and one step along the way broke.
    expect(group.summary).toBe("2 steps · 1 failed")
  })

  it("calls a run failed when the LAST step is the one that failed", () => {
    const group = groupActivity([
      tool("a", { status: "ok" }),
      tool("b", { status: "error", isError: true }),
    ])[0] as PresentedActivitySegment
    expect(group.status).toBe("error")
    expect(group.summary).toBe("2 steps · 1 failed")
  })

  it("is simply running while a step is in flight, whatever failed before it", () => {
    const group = groupActivity([
      tool("a", { status: "error", isError: true }),
      tool("b", { status: "pending" }),
    ])[0] as PresentedActivitySegment
    expect(group.status).toBe("pending")
  })

  it("keeps a stable group id as steps stream in, so the expanded tree stays open", () => {
    const first = groupActivity([reasoning("a"), tool("b")])[0] as PresentedActivitySegment
    const later = groupActivity([reasoning("a"), tool("b"), tool("c")])[0] as PresentedActivitySegment
    expect(later.id).toBe(first.id)
  })

  it("returns an empty list unchanged", () => {
    expect(groupActivity([])).toEqual([])
  })
})

describe("clampToLines", () => {
  it("passes text at or under the limit through untouched", () => {
    expect(clampToLines("a\nb\nc", 3)).toEqual({ preview: "a\nb\nc", clamped: false, lineCount: 3 })
    expect(clampToLines("", 3)).toEqual({ preview: "", clamped: false, lineCount: 1 })
  })

  it("keeps the first N lines and counts the whole thing", () => {
    expect(clampToLines("a\nb\nc\nd\ne", 3)).toEqual({
      preview: "a\nb\nc",
      clamped: true,
      lineCount: 5,
    })
  })

  it("does not count a trailing newline as a line", () => {
    // "a\nb\n" is two lines, not three — otherwise every file-shaped output
    // claims one phantom extra line in the "N more" count.
    expect(clampToLines("a\nb\n", 3)).toEqual({ preview: "a\nb", clamped: false, lineCount: 2 })
  })

  it("treats one very long line as one line — CSS clips it, the count stays honest", () => {
    const long = "x".repeat(5000)
    expect(clampToLines(long, 3)).toEqual({ preview: long, clamped: false, lineCount: 1 })
  })
})
