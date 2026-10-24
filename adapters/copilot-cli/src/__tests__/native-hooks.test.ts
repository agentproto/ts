import { describe, expect, it } from "vitest"
import { copilotCli } from "../index.js"
import { copilotCliNativeHooks } from "../native-hooks.js"

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
  ["prompt-submit", "userPromptSubmitted", "lifecycle", false],
  ["permission-request", "permissionRequest", "admission", true],
  ["compact-start", "preCompact", "lifecycle", false],
  ["subagent-start", "subagentStart", "lifecycle", false],
  ["subagent-end", "subagentStop", "admission", true],
  ["tool-call", "preToolUse", "admission", true],
  ["tool-result", "postToolUse", "lifecycle", false],
  ["turn-end", "agentStop", "admission", true],
  ["conversation-start", "sessionStart", "lifecycle", false],
  ["conversation-end", "sessionEnd", "lifecycle", false],
]

describe("copilot-cli native hook declarations", () => {
  it("exposes the declaration on the handle", () => {
    expect(copilotCli.capabilities?.hooks).toBe(copilotCliNativeHooks)
  })

  it("declares exactly the 10 matrix entries", () => {
    expect(copilotCliNativeHooks).toHaveLength(10)
    expect(
      copilotCliNativeHooks.map(hook => [
        hook.event,
        hook.native_event,
        hook.path,
        hook.can_block,
      ]),
    ).toEqual(EXPECTED)
  })

  it("has no turn-start entry", () => {
    expect(
      copilotCliNativeHooks.some(hook => hook.event === "turn-start"),
    ).toBe(false)
  })

  it("keeps lifecycle non-blocking and blocking only on admission", () => {
    for (const hook of copilotCliNativeHooks) {
      if (hook.path === "lifecycle") expect(hook.can_block).toBe(false)
      if (hook.can_block) expect(hook.path).toBe("admission")
    }
  })

  it("lists http on every entry and prompt only on conversation-start", () => {
    for (const hook of copilotCliNativeHooks) {
      expect(hook.handlers).toContain("http")
      if (hook.event !== "conversation-start") {
        expect(hook.handlers).not.toContain("prompt")
      }
    }
    const start = copilotCliNativeHooks.find(
      hook => hook.event === "conversation-start",
    )
    expect(start?.handlers).toContain("prompt")
  })

  it("uses only portable lifecycle event names", () => {
    for (const hook of copilotCliNativeHooks) {
      expect(ALLOWED_EVENTS).toContain(hook.event)
    }
  })

  it("does not repeat an event and native_event pair", () => {
    const pairs = copilotCliNativeHooks.map(
      hook => `${hook.event}\u0000${hook.native_event}`,
    )
    expect(new Set(pairs).size).toBe(pairs.length)
  })
})
