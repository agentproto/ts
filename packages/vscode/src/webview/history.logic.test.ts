import { describe, expect, it } from "vitest"

import { recallHistory, pushHistoryEntry, type PromptHistoryState } from "./history.logic.js"

function empty(): PromptHistoryState {
  return { entries: [], index: null, draft: "" }
}

describe("recallHistory", () => {
  it("prev on empty history is a no-op (don't consume the key)", () => {
    expect(recallHistory(empty(), "prev", "typing…")).toBeNull()
  })

  it("next when not navigating is a no-op", () => {
    const state: PromptHistoryState = { entries: ["a", "b"], index: null, draft: "" }
    expect(recallHistory(state, "next", "")).toBeNull()
  })

  it("prev from not-navigating saves the current draft and jumps to the newest entry", () => {
    const state: PromptHistoryState = { entries: ["first", "second", "third"], index: null, draft: "" }
    const result = recallHistory(state, "prev", "unsent draft")
    expect(result).toEqual({
      state: { entries: ["first", "second", "third"], index: 2, draft: "unsent draft" },
      value: "third",
    })
  })

  it("prev walks older one step at a time", () => {
    let state: PromptHistoryState = { entries: ["first", "second", "third"], index: null, draft: "" }
    let result = recallHistory(state, "prev", "")!
    expect(result.value).toBe("third")
    state = result.state
    result = recallHistory(state, "prev", "third")!
    expect(result.value).toBe("second")
    expect(result.state.index).toBe(1)
    state = result.state
    result = recallHistory(state, "prev", "second")!
    expect(result.value).toBe("first")
    expect(result.state.index).toBe(0)
  })

  it("stops at the oldest entry rather than wrapping", () => {
    const state: PromptHistoryState = { entries: ["only"], index: 0, draft: "draft" }
    expect(recallHistory(state, "prev", "only")).toBeNull()
  })

  it("next walks newer one step at a time", () => {
    const state: PromptHistoryState = { entries: ["first", "second", "third"], index: 0, draft: "draft" }
    const result = recallHistory(state, "next", "first")!
    expect(result.value).toBe("second")
    expect(result.state.index).toBe(1)
  })

  it("stepping past the newest entry restores the draft and exits navigation", () => {
    const state: PromptHistoryState = { entries: ["first", "second"], index: 1, draft: "unsent draft" }
    const result = recallHistory(state, "next", "second")!
    expect(result).toEqual({
      state: { entries: ["first", "second"], index: null, draft: "unsent draft" },
      value: "unsent draft",
    })
  })

  it("round-trips: prev to the oldest, then next all the way back to the draft", () => {
    let state = empty()
    state.entries = ["a", "b"]
    let result = recallHistory(state, "prev", "draft text")!
    expect(result.value).toBe("b")
    result = recallHistory(result.state, "prev", "b")!
    expect(result.value).toBe("a")
    result = recallHistory(result.state, "next", "a")!
    expect(result.value).toBe("b")
    result = recallHistory(result.state, "next", "b")!
    expect(result).toEqual({ state: { entries: ["a", "b"], index: null, draft: "draft text" }, value: "draft text" })
  })
})

describe("pushHistoryEntry", () => {
  it("appends a new entry and resets navigation", () => {
    const state: PromptHistoryState = { entries: ["a"], index: 0, draft: "stale" }
    const next = pushHistoryEntry(state, "b")
    expect(next).toEqual({ entries: ["a", "b"], index: null, draft: "" })
  })

  it("skips a consecutive duplicate but still resets navigation", () => {
    const state: PromptHistoryState = { entries: ["a", "b"], index: 0, draft: "stale" }
    const next = pushHistoryEntry(state, "b")
    expect(next).toEqual({ entries: ["a", "b"], index: null, draft: "" })
  })

  it("does not skip a non-consecutive duplicate", () => {
    const state: PromptHistoryState = { entries: ["a", "b"], index: null, draft: "" }
    const next = pushHistoryEntry(state, "a")
    expect(next.entries).toEqual(["a", "b", "a"])
  })

  it("ignores an empty push", () => {
    const state: PromptHistoryState = { entries: ["a"], index: 0, draft: "stale" }
    const next = pushHistoryEntry(state, "")
    expect(next).toEqual({ entries: ["a"], index: null, draft: "" })
  })

  it("caps at 100 entries, dropping the oldest", () => {
    let state = empty()
    for (let i = 0; i < 100; i++) state = pushHistoryEntry(state, "p" + i)
    expect(state.entries).toHaveLength(100)
    expect(state.entries[0]).toBe("p0")

    state = pushHistoryEntry(state, "p100")
    expect(state.entries).toHaveLength(100)
    expect(state.entries[0]).toBe("p1")
    expect(state.entries[state.entries.length - 1]).toBe("p100")
  })
})
