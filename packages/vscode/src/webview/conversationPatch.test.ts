import { describe, expect, it } from "vitest"

import { diffConversation } from "./conversationPatch.js"
import type { PresentedConversation, PresentedTurn } from "./conversation.js"

function turn(over: Partial<PresentedTurn> & { id: string }): PresentedTurn {
  return { role: "assistant", segments: [], ...over }
}

function conv(over: Partial<PresentedConversation> = {}): PresentedConversation {
  return { version: 1, sessionId: "s1", turns: [], ...over }
}

describe("diffConversation", () => {
  it("treats every turn as an upsert when prev is undefined", () => {
    const next = conv({ turns: [turn({ id: "turn-1" }), turn({ id: "turn-2" })] })
    const patch = diffConversation(undefined, next)
    expect(patch.upsertTurns.map(t => t.id)).toEqual(["turn-1", "turn-2"])
    expect(patch.removeTurnIds).toEqual([])
    expect(patch.empty).toBe(false)
  })

  it("is empty when nothing changed between two conversations with equal content", () => {
    const a = conv({ turns: [turn({ id: "turn-1", segments: [{ kind: "user", id: "seg-1", html: "hi" }] })] })
    const b = conv({ turns: [turn({ id: "turn-1", segments: [{ kind: "user", id: "seg-1", html: "hi" }] })] })
    const patch = diffConversation(a, b)
    expect(patch.upsertTurns).toEqual([])
    expect(patch.removeTurnIds).toEqual([])
    expect(patch.usage).toBeUndefined()
    expect(patch.empty).toBe(true)
  })

  it("is idempotent: diffing the same next twice yields empty the second time", () => {
    const prev = conv({ turns: [turn({ id: "turn-1" })] })
    const next = conv({ turns: [turn({ id: "turn-1" }), turn({ id: "turn-2" })] })
    const first = diffConversation(prev, next)
    expect(first.empty).toBe(false)
    const second = diffConversation(next, next)
    expect(second.empty).toBe(true)
    expect(second.upsertTurns).toEqual([])
    expect(second.removeTurnIds).toEqual([])
  })

  it("upserts only the turn whose content changed (streaming delta on the last turn)", () => {
    const prev = conv({
      turns: [
        turn({ id: "turn-1", role: "user", segments: [{ kind: "user", id: "seg-1", html: "hello" }] }),
        turn({ id: "turn-2", segments: [{ kind: "assistant-text", id: "seg-2", html: "Hi" }] }),
      ],
    })
    const next = conv({
      turns: [
        turn({ id: "turn-1", role: "user", segments: [{ kind: "user", id: "seg-1", html: "hello" }] }),
        turn({ id: "turn-2", segments: [{ kind: "assistant-text", id: "seg-2", html: "Hi there" }] }),
      ],
    })
    const patch = diffConversation(prev, next)
    expect(patch.upsertTurns.map(t => t.id)).toEqual(["turn-2"])
    expect(patch.empty).toBe(false)
  })

  it("reports removed turn ids when a re-reduce drops a turn", () => {
    const prev = conv({ turns: [turn({ id: "turn-1" }), turn({ id: "turn-2" })] })
    const next = conv({ turns: [turn({ id: "turn-1" })] })
    const patch = diffConversation(prev, next)
    expect(patch.removeTurnIds).toEqual(["turn-2"])
    expect(patch.upsertTurns).toEqual([])
    expect(patch.empty).toBe(false)
  })

  it("preserves document order in upsertTurns even for a late-arriving earlier turn", () => {
    const prev = conv({ turns: [turn({ id: "turn-2" })] })
    const next = conv({ turns: [turn({ id: "turn-1" }), turn({ id: "turn-2" })] })
    const patch = diffConversation(prev, next)
    expect(patch.upsertTurns.map(t => t.id)).toEqual(["turn-1"])
  })

  it("includes usage only when it changed", () => {
    const prev = conv({ turns: [], usage: { seq: 1, tokensIn: 10 } })
    const sameUsage = conv({ turns: [], usage: { seq: 1, tokensIn: 10 } })
    const changedUsage = conv({ turns: [], usage: { seq: 2, tokensIn: 20 } })

    expect(diffConversation(prev, sameUsage).usage).toBeUndefined()
    expect(diffConversation(prev, sameUsage).empty).toBe(true)

    const patch = diffConversation(prev, changedUsage)
    expect(patch.usage).toEqual({ seq: 2, tokensIn: 20 })
    expect(patch.empty).toBe(false)
  })

  it("treats a turn as unchanged when the presenter reproduces identical field order", () => {
    // presentSegment/presentConversation build fields in a fixed order per
    // call site, so re-presenting the same semantic state twice (the normal
    // poll-tick case) must diff as empty — this is the property the
    // stringify-based equality actually relies on.
    const a = conv({
      turns: [{ id: "turn-1", role: "assistant", segments: [{ kind: "assistant-text", id: "seg-1", html: "x" }] }],
    })
    const b = conv({
      turns: [{ id: "turn-1", role: "assistant", segments: [{ kind: "assistant-text", id: "seg-1", html: "x" }] }],
    })
    const patch = diffConversation(a, b)
    expect(patch.upsertTurns).toEqual([])
    expect(patch.empty).toBe(true)
  })
})
