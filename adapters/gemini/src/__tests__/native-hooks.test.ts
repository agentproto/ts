import { describe, expect, it } from "vitest"
import { gemini } from "../index.js"
import { geminiNativeHooks } from "../native-hooks.js"

// @agentproto/lifecycle is not a dependency of this adapter, so the allowed
// event list is hard-coded here instead of imported from LIFECYCLE_EVENTS.
const ALLOWED_EVENTS = [
  "workspace-open",
  "workspace-close",
  "conversation-start",
  "conversation-end",
  "turn-start",
  "turn-end",
  "turn-error",
  "turn-interrupt",
  "prompt-submit",
  "permission-request",
  "compact-start",
  "compact-end",
  "subagent-start",
  "subagent-end",
  "tool-call",
  "tool-result",
  "tool-error",
  "write",
  "delete",
  "manual",
]

const EXPECTED = [
  ["prompt-submit", "BeforeAgent", "admission", true],
  ["compact-start", "PreCompress", "lifecycle", false],
  ["tool-call", "BeforeTool", "admission", true],
  ["tool-result", "AfterTool", "lifecycle", false],
  ["turn-end", "AfterAgent", "lifecycle", false],
  ["conversation-start", "SessionStart", "lifecycle", false],
  ["conversation-end", "SessionEnd", "lifecycle", false],
]

describe("gemini native hook declarations", () => {
  it("exposes the declaration on the handle", () => {
    expect(gemini.capabilities?.hooks).toBe(geminiNativeHooks)
  })

  it("declares exactly the 7 matrix entries", () => {
    expect(geminiNativeHooks).toHaveLength(7)
    expect(
      geminiNativeHooks.map(hook => [
        hook.event,
        hook.native_event,
        hook.path,
        hook.can_block,
      ]),
    ).toEqual(EXPECTED)
  })

  it("has no turn-start entry", () => {
    expect(geminiNativeHooks.some(hook => hook.event === "turn-start")).toBe(
      false,
    )
  })

  it("keeps lifecycle non-blocking and blocking only on admission", () => {
    for (const hook of geminiNativeHooks) {
      if (hook.path === "lifecycle") expect(hook.can_block).toBe(false)
      if (hook.can_block) expect(hook.path).toBe("admission")
    }
  })

  it("runs every entry synchronously with only a command handler", () => {
    for (const hook of geminiNativeHooks) {
      expect(hook.handlers).toEqual(["command"])
      expect(hook.async).toBe(false)
    }
  })

  it("uses only portable lifecycle event names", () => {
    for (const hook of geminiNativeHooks) {
      expect(ALLOWED_EVENTS).toContain(hook.event)
    }
  })

  it("does not repeat an event and native_event pair", () => {
    const pairs = geminiNativeHooks.map(
      hook => `${hook.event}\u0000${hook.native_event}`,
    )
    expect(new Set(pairs).size).toBe(pairs.length)
  })
})
